// Produce the same square used by the device, with a circular preview.
export async function cropPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const dialog = document.createElement("dialog");
  dialog.className = "photo-crop";
  dialog.setAttribute("aria-labelledby", "crop-title");
  dialog.innerHTML = `<form><h2 id="crop-title">调整圆屏裁切</h2>
    <canvas width="466" height="466" aria-label="挂件圆屏预览"></canvas>
    <label>左右位置 <input name="horizontal" type="range" min="0" max="100" value="50"></label>
    <label>上下位置 <input name="vertical" type="range" min="0" max="100" value="50"></label>
    <label>缩放 <input name="zoom" type="range" min="100" max="300" value="100"></label>
    <div class="actions"><button type="button" class="secondary" data-cancel>取消</button>
    <button type="submit">保存这张照片</button></div><p role="status"></p></form>`;
  const form = dialog.querySelector("form");
  const canvas = dialog.querySelector("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    bitmap.close();
    throw new Error("此浏览器无法裁切照片");
  }
  const { horizontal, vertical, zoom } = form.elements;
  function draw() {
    const side = Math.min(bitmap.width, bitmap.height) * 100 / zoom.valueAsNumber;
    const x = (bitmap.width - side) * horizontal.valueAsNumber / 100;
    const y = (bitmap.height - side) * vertical.valueAsNumber / 100;
    context.drawImage(bitmap, x, y, side, side, 0, 0, canvas.width, canvas.height);
  }
  form.addEventListener("input", draw);
  dialog.querySelector("[data-cancel]").onclick = () => dialog.close();
  document.body.append(dialog);
  return new Promise((resolve) => {
    let result = null;
    dialog.addEventListener("close", () => {
      bitmap.close();
      dialog.remove();
      resolve(result);
    }, { once: true });
    form.onsubmit = event => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      canvas.toBlob(blob => {
        if (!dialog.open) return;
        if (blob) {
          result = blob;
          dialog.close();
        } else {
          form.querySelector('[role="status"]').textContent = "暂时无法生成照片，请重试。";
          button.disabled = false;
        }
      }, "image/png");
    };
    draw();
    dialog.showModal();
  });
}
