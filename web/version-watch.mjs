export function watchVersion(build) {
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
      if (
        next.build !== build &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          document.activeElement?.tagName,
        )
      )
        location.reload();
    } catch {
    } finally {
      checking = false;
    }
  };
  setInterval(check, 60000);
  window.addEventListener("focus", check);
}
