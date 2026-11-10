export function watchVersion(build, mode, canReload) {
  if (!build || build === "local") return;
  let checking = false;
  const check = async () => {
    if (document.hidden || checking) return;
    checking = true;
    try {
      const url = new URL("version.json", import.meta.url);
      url.searchParams.set("poll", String(Math.floor(Date.now() / 60000)));
      const res = await fetch(url, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const next = await res.json();
      if (next.mode !== mode || !/^[a-f0-9]{40}$/.test(next.build) ||
          !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(next.version) || next.build === build ||
          document.hidden || !canReload() || document.querySelector("dialog[open]") ||
          document.activeElement?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (Array.from(document.querySelectorAll("input, textarea, select")).some(field => {
        if (field.type === "checkbox" || field.type === "radio") return field.checked !== field.defaultChecked;
        if (field instanceof HTMLSelectElement) {
          const initial = Array.from(field.options).find(option => option.defaultSelected) || field.options[0];
          return !!initial && field.value !== initial.value;
        }
        return field.value !== field.defaultValue;
      })) return;
      // A proxy can briefly serve a fresh version.json alongside older HTML.
      // Try each target once per minute in that case instead of looping.
      const key = `sw-version:${build}:${next.build}`;
      if (Date.now() - Number(sessionStorage.getItem(key)) < 60000) return;
      sessionStorage.setItem(key, String(Date.now()));
      location.reload();
    } catch {
    } finally {
      checking = false;
    }
  };
  setInterval(check, 60000);
  window.addEventListener("focus", check);
}
