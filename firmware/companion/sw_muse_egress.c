#include "sw_muse_egress.h"
#include "sw_sync.h"
#include "sw_sync_build.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_transport.h"
#include "esp_transport_ssl.h"
#include "esp_transport_ws.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/net_sockets.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/ssl.h"
#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define CONNECTIONS 8
#define EXTERNAL (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
typedef struct {
  void *inner;
  TaskHandle_t owner;
  esp_transport_handle_t ssl, ws;
  int fd;
  bool creating, api, ready, failed;
  char gateway[161], path[320], auth[40];
} connection_t;
static connection_t *connections[CONNECTIONS];
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t network;
static int64_t direct_after;
static atomic_uint opened, api_tls, vm_tls, direct_failures, sent, received, external_allocations;
static atomic_int last_http, last_error, route;

bool sw_muse_egress_target(const char *host, int length, int port) {
  if (!host || length < 1 || length > 253 || port != 443) return false;
  int label = 0;
  for (int i = 0; i < length; ++i) {
    unsigned char c = host[i];
    if (c == '.') {
      if (!label || host[i-1] == '-') return false;
      label = 0;
    } else {
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || (c == '-' && label)) || ++label > 63) return false;
    }
  }
  if (!label || host[length-1] == '-') return false;
  const char api[] = "api.muse.ai", suffix[] = ".metaaivm.com";
  return ((size_t)length == sizeof(api)-1 && !strncasecmp(host, api, length)) ||
         ((size_t)length > sizeof(suffix)-1 && !strncasecmp(host+length-(sizeof(suffix)-1), suffix, sizeof(suffix)-1));
}
bool sw_muse_egress_ready(void) {
  char token[33];
  bool ok = !strncmp(SW_RELAY_ORIGIN, "https://", 8) &&
      SW_RELAY_ORIGIN[8] && !strchr(SW_RELAY_ORIGIN+8, ':') &&
      sw_sync_muse_credential(token);
  mbedtls_platform_zeroize(token, sizeof(token));
  return ok;
}
bool sw_muse_egress_direct_due(void) {
  uint32_t key = 2166136261u;
  wifi_ap_record_t ap;
  if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK)
    for (unsigned i=0;i<6;i++) key=(key^ap.bssid[i])*16777619u;
  int64_t now = esp_timer_get_time();
  portENTER_CRITICAL(&lock);
  if (network != key) { network=key; direct_after=0; }
  bool due = now >= direct_after;
  portEXIT_CRITICAL(&lock);
  return due;
}
void sw_muse_egress_direct_failed(void) {
  portENTER_CRITICAL(&lock);
  direct_after = esp_timer_get_time()+300000000;
  portEXIT_CRITICAL(&lock);
  atomic_fetch_add(&direct_failures,1);
}
static connection_t *reserve(void) {
  connection_t *c=heap_caps_calloc(1,sizeof(*c),EXTERNAL);
  if (!c) return NULL;
  c->fd=-1;
  portENTER_CRITICAL(&lock);
  for(unsigned i=0;i<CONNECTIONS;i++) if (!connections[i]) {
    connections[i]=c; portEXIT_CRITICAL(&lock); return c;
  }
  portEXIT_CRITICAL(&lock); free(c); return NULL;
}
static connection_t *find(void *inner, int fd) {
  connection_t *found=NULL;
  portENTER_CRITICAL(&lock);
  for(unsigned i=0;i<CONNECTIONS;i++) {
    connection_t *c=connections[i];
    if (c && ((inner && c->inner==inner) || (!inner && fd>=0 && c->fd==fd))) { found=c; break; }
  }
  portEXIT_CRITICAL(&lock); return found;
}
static bool drop(connection_t *c) {
  bool managed=c && c->ws;
  if (!c) return false;
  portENTER_CRITICAL(&lock);
  for(unsigned i=0;i<CONNECTIONS;i++) if(connections[i]==c) connections[i]=NULL;
  portEXIT_CRITICAL(&lock);
  // Remove ownership first: destroying the outer TLS must not recurse here.
  if(c->ws) {esp_transport_close(c->ws);esp_transport_destroy(c->ws);}
  if(c->ssl) esp_transport_destroy(c->ssl);
  mbedtls_platform_zeroize(c,sizeof(*c));free(c);return managed;
}
void *sw_muse_egress_alloc(size_t size, bool *handled) {
  bool outer=false;TaskHandle_t owner=xTaskGetCurrentTaskHandle();
  portENTER_CRITICAL(&lock);
  for(unsigned i=0;i<CONNECTIONS;i++) if(connections[i] && connections[i]->creating && connections[i]->owner==owner) {outer=true;break;}
  portEXIT_CRITICAL(&lock);
  *handled=outer;
  if (!outer) return NULL;
  atomic_fetch_add(&external_allocations,1);
  // Only outer TLS metadata/WS buffers, never DMA or another task's stack.
  return heap_caps_calloc(1,size,EXTERNAL);
}
esp_err_t sw_muse_egress_connect(const char *host,int length,int timeout_ms,int *fd) {
  if(!fd || !sw_muse_egress_target(host,length,443) || !sw_muse_egress_ready()) return ESP_ERR_INVALID_STATE;
  *fd=-1;
  if(heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT)<12000 ||
     heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT)<4096 ||
     heap_caps_get_free_size(EXTERNAL)<98304) return ESP_ERR_NO_MEM;
  connection_t *c=reserve();if(!c) return ESP_ERR_NO_MEM;
  portENTER_CRITICAL(&lock);
  c->owner=xTaskGetCurrentTaskHandle();c->creating=true;
  portEXIT_CRITICAL(&lock);
  strlcpy(c->gateway,SW_RELAY_ORIGIN+8,sizeof(c->gateway));
  snprintf(c->path,sizeof(c->path),"/api/device/muse-tunnel?host=%.*s",length,host);
  for(char *p=strchr(c->path,'=')+1;*p;p++) if(*p>='A' && *p<='Z') *p+='a'-'A';
  c->api=length==11 && !strncasecmp(host,"api.muse.ai",11);
  char token[33];
  if(!sw_sync_muse_credential(token)) {drop(c);return ESP_ERR_INVALID_STATE;}
  snprintf(c->auth,sizeof(c->auth),"Bearer %s",token);
  mbedtls_platform_zeroize(token,sizeof(token));
  esp_transport_handle_t ssl=esp_transport_ssl_init();
  esp_transport_handle_t ws=ssl?esp_transport_ws_init(ssl):NULL;
  portENTER_CRITICAL(&lock);c->ssl=ssl;c->ws=ws;portEXIT_CRITICAL(&lock);
  if(!c->ws) {drop(c);return ESP_ERR_NO_MEM;}
  esp_transport_ssl_crt_bundle_attach(c->ssl,esp_crt_bundle_attach);
  esp_transport_ssl_set_common_name(c->ssl,c->gateway);
  esp_transport_ws_set_path(c->ws,c->path);
  esp_err_t configured=esp_transport_ws_set_auth(c->ws,c->auth);
  mbedtls_platform_zeroize(c->auth,sizeof(c->auth));
  if(timeout_ms<=0 || timeout_ms>8000) timeout_ms=8000;
  int result=configured==ESP_OK?esp_transport_connect(c->ws,c->gateway,443,timeout_ms):-1;
  atomic_store(&last_http,esp_transport_ws_get_upgrade_request_status(c->ws));
  atomic_store(&last_error,result);
  int socket=result<0?-1:esp_transport_get_socket(c->ws);
  portENTER_CRITICAL(&lock);c->creating=false;c->fd=socket;portEXIT_CRITICAL(&lock);
  if(result<0 || socket<0) {drop(c);return ESP_FAIL;}
  atomic_store(&route,2);atomic_fetch_add(&opened,1);*fd=c->fd;return ESP_OK;
}
void sw_muse_egress_bind(void *tls,int fd,const char *host,int length,int port) {
  if(!sw_muse_egress_target(host,length,port)) return;
  connection_t *c=find(NULL,fd);
  if(!c && sw_muse_egress_ready()) c=reserve();
  if(c) {
    portENTER_CRITICAL(&lock);
    c->inner=tls;c->fd=fd;c->api=length==11 && !strncasecmp(host,"api.muse.ai",11);
    portEXIT_CRITICAL(&lock);
  }
}
static int tunnel_send(void *ctx,const unsigned char *data,size_t size) {
  connection_t *c=ctx;
  int count=esp_transport_write(c->ws,(const char *)data,(int)size,5000);
  if(count!=(int)size) return MBEDTLS_ERR_NET_SEND_FAILED;
  atomic_fetch_add(&sent,count);return count;
}
static int tunnel_recv(void *ctx,unsigned char *data,size_t size) {
  connection_t *c=ctx;int ready=esp_transport_poll_read(c->ws,100);
  if(!ready) return MBEDTLS_ERR_SSL_WANT_READ;
  if(ready<0) return MBEDTLS_ERR_NET_RECV_FAILED;
  int count=esp_transport_read(c->ws,(char *)data,(int)size,100);
  if(count<0) return (errno==EAGAIN || errno==EWOULDBLOCK || errno==ETIMEDOUT)?MBEDTLS_ERR_SSL_WANT_READ:MBEDTLS_ERR_NET_RECV_FAILED;
  if(count>0) atomic_fetch_add(&received,count);
  return count;
}
void sw_muse_egress_bio(void *tls,void *ssl) {
  connection_t *c=find(tls,-1);
  if(c && c->ws) mbedtls_ssl_set_bio((mbedtls_ssl_context *)ssl,c,tunnel_send,tunnel_recv,NULL);
}
int sw_muse_egress_pending(void *tls) {
  connection_t *c=find(tls,-1);
  return c && c->ws && esp_transport_poll_read(c->ws,0)>0;
}
void sw_muse_egress_result(void *tls,int result) {
  connection_t *c=find(tls,-1);if(!c) return;
  bool success=false,failed=false;
  portENTER_CRITICAL(&lock);
  if(result==1 && !c->ready) {
    c->ready=true;success=true;
  } else if(result<0 && !c->ws && !c->failed) {c->failed=true;failed=true;}
  portEXIT_CRITICAL(&lock);
  if(success) {if(c->ws) atomic_fetch_add(c->api?&api_tls:&vm_tls,1);else atomic_store(&route,1);}
  if(failed) sw_muse_egress_direct_failed();
}
bool sw_muse_egress_release(void *tls) {return drop(find(tls,-1));}
bool sw_muse_egress_abort_fd(int fd) {return drop(find(NULL,fd));}
void sw_muse_egress_status(int id) {
  unsigned active=0;
  portENTER_CRITICAL(&lock);
  for(unsigned i=0;i<CONNECTIONS;i++) if(connections[i] && connections[i]->ws) active++;
  portEXIT_CRITICAL(&lock);
  printf("@sw {\"id\":%d,\"ok\":true,\"configured\":%s,\"route\":\"%s\",\"active\":%u,"
         "\"opened\":%u,\"apiTls\":%u,\"vmTls\":%u,\"directFailures\":%u,"
         "\"sent\":%u,\"received\":%u,\"lastHttp\":%d,\"lastError\":%d,\"externalAllocations\":%u}\n",
         id,sw_muse_egress_ready()?"true":"false",atomic_load(&route)==2?"vps":atomic_load(&route)==1?"direct":"pending",active,
         atomic_load(&opened),atomic_load(&api_tls),atomic_load(&vm_tls),atomic_load(&direct_failures),
         atomic_load(&sent),atomic_load(&received),atomic_load(&last_http),atomic_load(&last_error),atomic_load(&external_allocations));
  fflush(stdout);
}
