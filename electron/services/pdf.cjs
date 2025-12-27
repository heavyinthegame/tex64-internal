const { BrowserWindow } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

class PDFWindowManager {
  constructor() {
    this.window = null;
    this.currentPath = null;
  }

  show(pdfPath) {
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({
        width: 860,
        height: 680,
        title: "PDF",
        backgroundColor: "#1c2129",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      this.window.on("closed", () => {
        this.window = null;
        this.currentPath = null;
      });
    }

    const fileUrl = pathToFileURL(pdfPath).toString();
    const cacheBust = `?t=${Date.now()}`;
    const targetUrl = `${fileUrl}${cacheBust}`;

    this.window.setTitle(path.basename(pdfPath));
    this.window.loadURL(targetUrl);
    this.window.show();
    this.currentPath = pdfPath;
  }
}

module.exports = {
  PDFWindowManager,
};
