import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const platform = `
#pragma once
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_INVALID_ARG 1
#define ESP_ERR_INVALID_STATE 2
#define ESP_ERR_NO_MEM 3
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(p) ((void)(p))
#define portEXIT_CRITICAL(p) ((void)(p))
typedef int nvs_handle_t;
#define NVS_READONLY 0
#define NVS_READWRITE 1
typedef struct esp_netif esp_netif_t;
typedef struct { uint32_t addr; } ip4_test_t;
typedef struct { ip4_test_t ip, gw; } esp_netif_ip_info_t;
typedef intptr_t ssize_t;
typedef unsigned socklen_t;
struct in_addr { uint32_t s_addr; };
struct sockaddr { unsigned short family; char data[14]; };
struct sockaddr_in { unsigned short sin_family, sin_port; struct in_addr sin_addr; };
struct timeval { long tv_sec, tv_usec; };
typedef struct { unsigned bits; } fd_set;
#define FD_ZERO(p) ((p)->bits=0)
#define FD_SET(fd,p) ((p)->bits|=1u<<(fd))
#define AF_INET 2
#define SOCK_STREAM 1
#define IPPROTO_TCP 6
#define SOL_SOCKET 1
#define SO_ERROR 4
#define SO_RCVTIMEO 5
#define SO_SNDTIMEO 6
#define F_GETFL 1
#define F_SETFL 2
#define O_NONBLOCK 128
#ifndef EPROTO
#define EPROTO 134
#endif
void *heap_caps_malloc(size_t, unsigned);
void proxy_test_free(void *);
void proxy_test_warn(const char *, const char *, ...);
#define ESP_LOGW proxy_test_warn
int64_t esp_timer_get_time(void);
esp_netif_t *esp_netif_get_handle_from_ifkey(const char *);
int esp_netif_get_ip_info(esp_netif_t *, esp_netif_ip_info_t *);
int nvs_open(const char *, int, nvs_handle_t *);
int nvs_get_blob(nvs_handle_t,const char *,void *,size_t *);
int nvs_set_blob(nvs_handle_t,const char *,const void *,size_t);
int nvs_erase_all(nvs_handle_t);
int nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
int proxy_test_inet_pton(int,const char *,void *);
uint32_t proxy_test_ntohl(uint32_t);
uint16_t proxy_test_htons(uint16_t);
int proxy_test_socket(int,int,int);
int proxy_test_connect(int,const struct sockaddr *,size_t);
int proxy_test_fcntl(int,int,...);
int proxy_test_select(int,fd_set *,fd_set *,fd_set *,struct timeval *);
int proxy_test_getsockopt(int,int,int,void *,socklen_t *);
int proxy_test_setsockopt(int,int,int,const void *,size_t);
ssize_t proxy_test_send(int,const void *,size_t,int);
ssize_t proxy_test_recv(int,void *,size_t,int);
int proxy_test_close(int);
#define free proxy_test_free
#define inet_pton proxy_test_inet_pton
#define ntohl proxy_test_ntohl
#define htons proxy_test_htons
#define socket proxy_test_socket
#define connect proxy_test_connect
#define fcntl proxy_test_fcntl
#define select proxy_test_select
#define getsockopt proxy_test_getsockopt
#define setsockopt proxy_test_setsockopt
#define send proxy_test_send
#define recv proxy_test_recv
#define close proxy_test_close
`;

test("Muse CONNECT transport bounds headers, preserves TLS bytes, and cleans up failures", async () => {
  await mkdir(".data", { recursive: true });
  const scratch = await mkdtemp(path.resolve(".data/muse-proxy-host-"));
  try {
    await writeFile(path.join(scratch, "test-platform.h"), platform);
    for (const header of ["esp_err.h", "esp_heap_caps.h", "esp_log.h", "esp_netif.h", "esp_timer.h",
      "freertos/FreeRTOS.h", "freertos/portmacro.h", "lwip/inet.h", "lwip/sockets.h", "nvs.h", "fcntl.h"]) {
      await mkdir(path.dirname(path.join(scratch, header)), { recursive: true });
      await writeFile(path.join(scratch, header), '#include "test-platform.h"\n');
    }
    const executable = path.join(scratch, process.platform === "win32" ? "check.exe" : "check");
    const compiler = path.resolve(`.tools/host/ziglang/${process.platform === "win32" ? "zig.exe" : "zig"}`);
    execFileSync(compiler, ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-I" + scratch, "-Ifirmware/companion", "tests/muse-proxy-host.c", "-o", executable], {
      env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: path.resolve(".tools/zig-cache") },
      stdio: "pipe",
    });
    assert.match(execFileSync(executable, [], { encoding: "utf8", timeout: 10000 }),
      /Muse CONNECT host checks passed/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
