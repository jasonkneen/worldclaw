if (typeof FileReader === "undefined") {
  globalThis.FileReader = class FileReader {
    result = null;
    onloadend = null;
    readAsArrayBuffer(blob) {
      Promise.resolve(blob.arrayBuffer()).then((buffer) => {
        this.result = buffer;
        this.onloadend?.();
      });
    }
  };
}
