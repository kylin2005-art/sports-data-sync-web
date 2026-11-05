const pngType = 'image/png';
const pngPrefix = 'data:image/png;base64,';

function downloadBlob(blob, filename, document) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  try {
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function downloadCanvas(canvas, filename) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, pngType));
  if (!blob) throw new Error('无法生成 PNG 图片。');
  downloadBlob(blob, filename, canvas.ownerDocument);
  return 'downloaded';
}

export async function shareCanvas(canvas, filename) {
  let file;
  let shareData;
  if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    try {
      // A synchronous encode keeps file sharing inside the click's activation.
      const png = canvas.toDataURL(pngType);
      if (png.startsWith(pngPrefix) && png.length > pngPrefix.length) {
        const bytes = Uint8Array.from(atob(png.slice(pngPrefix.length)), char => char.charCodeAt(0));
        file = new File([bytes], filename, { type: pngType });
        const data = { files: [file] };
        if (navigator.canShare(data)) shareData = data;
      }
    } catch {
      // Try the regular PNG download if the device cannot prepare a share file.
    }
  }
  if (shareData) {
    try {
      await navigator.share(shareData);
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
    }
  }
  if (!file) return downloadCanvas(canvas, filename);
  downloadBlob(file, filename, canvas.ownerDocument);
  return 'downloaded';
}
