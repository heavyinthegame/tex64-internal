//
//  PDFWindowController.swift
//  tex180
//
//  Created by Codex.
//

import AppKit
import PDFKit

final class PDFWindowController: NSWindowController {
    private let pdfView = PDFView()
    private var currentURL: URL?

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 860, height: 680),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "PDF"
        window.isReleasedWhenClosed = false
        pdfView.autoScales = true
        window.contentView = pdfView
        super.init(window: window)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(pdfURL: URL) {
        guard let document = PDFDocument(url: pdfURL) else {
            return
        }
        currentURL = pdfURL
        pdfView.document = document
        window?.title = pdfURL.lastPathComponent
        showWindow(nil)
    }
}
