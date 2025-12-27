//
//  WebView.swift
//  tex180
//
//  Created by Codex.
//

import AppKit
import Foundation
import SwiftUI
import WebKit

enum WebViewLoadState: Equatable {
    case idle
    case loading
    case loaded
    case failed(WebViewFailure)
}

enum WebViewFailure: Equatable {
    case loadFailed
    case processTerminated
}

struct WebView: NSViewRepresentable {
    let url: URL
    @Binding var state: WebViewLoadState
    @ObservedObject var appModel: AppModel

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "tex180")
        let webView = NoContextMenuWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.attachWebView(webView)
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        guard nsView.url != url else { return }
        nsView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(state: $state, appModel: appModel)
    }

    final class NoContextMenuWebView: WKWebView {
        override func menu(for event: NSEvent) -> NSMenu? {
            nil
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private var state: Binding<WebViewLoadState>
        private let appModel: AppModel
        private weak var webView: WKWebView?
        private var currentWorkspacePath: String?

        init(state: Binding<WebViewLoadState>, appModel: AppModel) {
            self.state = state
            self.appModel = appModel
        }

        deinit {
            webView?.configuration.userContentController.removeScriptMessageHandler(forName: "tex180")
        }

        func attachWebView(_ webView: WKWebView) {
            self.webView = webView
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            updateState(.loading)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            updateState(.loaded)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            updateState(.failed(.loadFailed))
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            updateState(.failed(.loadFailed))
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            updateState(.failed(.processTerminated))
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "tex180" else { return }
            guard let body = message.body as? [String: Any] else { return }
            guard let type = body["type"] as? String else { return }
            switch type {
            case "build":
                let mainFile = body["mainFile"] as? String
                handleBuildRequest(mainFile: mainFile)
            case "ready":
                handleReady()
            case "requestWorkspace":
                handleWorkspaceRequest()
            case "openFile":
                if let path = body["path"] as? String {
                    handleOpenFile(path: path)
                }
            case "saveFile":
                if let path = body["path"] as? String,
                   let content = body["content"] as? String {
                    handleSaveFile(path: path, content: content)
                }
            case "createFile":
                if let path = body["path"] as? String {
                    handleCreateFile(path: path)
                }
            case "createFolder":
                if let path = body["path"] as? String {
                    handleCreateFolder(path: path)
                }
            case "revealInFinder":
                if let path = body["path"] as? String {
                    handleRevealInFinder(path: path)
                }
            case "openInTerminal":
                if let path = body["path"] as? String {
                    handleOpenInTerminal(path: path)
                }
            case "renameItem":
                if let path = body["path"] as? String,
                   let newName = body["newName"] as? String {
                    handleRenameItem(path: path, newName: newName)
                }
            case "deleteItem":
                if let path = body["path"] as? String {
                    handleDeleteItem(path: path)
                }
            case "moveItem":
                if let path = body["path"] as? String,
                   let destination = body["destination"] as? String {
                    handleMoveItem(path: path, destination: destination)
                }
            case "copyItem":
                if let path = body["path"] as? String,
                   let destination = body["destination"] as? String {
                    handleCopyItem(path: path, destination: destination)
                }
            case "undoFileOperation":
                handleUndoFileOperation()
            case "setRoot":
                if let path = body["path"] as? String {
                    handleSetRoot(path: path)
                }
            case "detectRoot":
                handleDetectRoot()
            case "requestIndex":
                handleIndexRequest()
            case "loadBlocks":
                handleLoadBlocks()
            case "saveBlocks":
                if let blocks = body["blocks"] as? [[String: Any]] {
                    handleSaveBlocks(blocks)
                }
            case "search":
                if let query = body["query"] as? String {
                    handleSearch(query: query)
                }
            case "gitStatus":
                handleGitStatus()
            default:
                break
            }
        }

        private func updateState(_ newState: WebViewLoadState) {
            DispatchQueue.main.async {
                self.state.wrappedValue = newState
            }
        }

        private func handleBuildRequest(mainFile: String?) {
            guard let webView else { return }
            sendBuildState("building", message: "ビルド中...")
            sendIssues(count: 0, summary: "ビルド中...", status: "info", issues: [])
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendBuildState("idle", message: "キャンセル")
                    self.sendIssues(count: 0, summary: "ビルドをキャンセルしました。", status: "info", issues: [])
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                let rootFile = self.appModel.workspaceManager.rootInfo(rootURL: rootURL)?.path
                let targetFile = (mainFile?.isEmpty == false ? mainFile : nil)
                    ?? rootFile
                    ?? "main.tex"
                self.appModel.buildService.build(rootURL: rootURL, mainFileName: targetFile) { result in
                    switch result {
                    case .busy:
                        self.sendBuildState("building", message: "ビルド中...")
                        self.sendIssues(count: 0, summary: "すでにビルド中です。", status: "info", issues: [])
                    case .success(let summary, let issues, let pdfURL):
                        let warningIssues = issues.filter { $0.severity == .warning }
                        let warningCount = warningIssues.count
                        let summaryText = warningIssues.first?.message ?? summary
                        if FileManager.default.fileExists(atPath: pdfURL.path) {
                            self.appModel.pdfWindowController.show(pdfURL: pdfURL)
                            if warningCount > 0 {
                                self.sendBuildState("success", message: summary)
                                self.sendIssues(count: warningCount, summary: summaryText, status: "info", issues: warningIssues)
                            } else {
                                self.sendBuildState("success", message: summary)
                                self.sendIssues(count: 0, summary: summary, status: "success", issues: [])
                            }
                        } else {
                            self.sendBuildState("failed", message: "PDFが見つかりません。")
                            let issue = BuildIssue(severity: .error, message: "PDFが見つかりません。", line: nil)
                            self.sendIssues(count: 1, summary: "PDFが見つかりません。", status: "error", issues: [issue])
                        }
                    case .failure(let summary, let issues):
                        let count = max(issues.count, 1)
                        let summaryText = issues.first?.message ?? summary
                        self.sendBuildState("failed", message: summary)
                        self.sendIssues(count: count, summary: summaryText, status: "error", issues: issues)
                    }
                }
            }
        }

        private func handleWorkspaceRequest() {
            guard let webView else { return }
            appModel.workspaceManager.selectWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 0, summary: "フォルダ選択をキャンセルしました。", status: "info", issues: [])
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL, force: true)
                self.requestIndex(rootURL: rootURL)
            }
        }

        private func handleReady() {
            guard let rootURL = appModel.workspaceManager.rootURL else {
                return
            }
            updateWorkspaceIfNeeded(rootURL: rootURL, force: true)
            requestIndex(rootURL: rootURL)
        }

        private func handleOpenFile(path: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendOpenFileResult(path: path, content: nil, error: "ワークスペースが選択されていません。")
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = self.appModel.workspaceManager.readFile(rootURL: rootURL, relativePath: path)
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let content):
                            self.sendOpenFileResult(path: path, content: content, error: nil)
                        case .failure(let error):
                            self.sendOpenFileResult(path: path, content: nil, error: error.localizedDescription)
                        }
                    }
                }
            }
        }

        private func handleSaveFile(path: String, content: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendSaveResult(path: path, ok: false, message: "ワークスペースが選択されていません。")
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = self.appModel.workspaceManager.writeFile(
                        rootURL: rootURL,
                        relativePath: path,
                        content: content
                    )
                    DispatchQueue.main.async {
                        switch result {
                        case .success:
                            self.sendSaveResult(path: path, ok: true, message: nil)
                            if path.lowercased().hasSuffix(".tex")
                                || path.lowercased().hasSuffix(".bib") {
                                self.requestIndex(rootURL: rootURL)
                            }
                        case .failure(let error):
                            self.sendSaveResult(path: path, ok: false, message: error.localizedDescription)
                        }
                    }
                }
            }
        }

        private func handleCreateFile(path: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                    ])
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = self.appModel.workspaceManager.createFile(rootURL: rootURL, relativePath: path)
                    DispatchQueue.main.async {
                        switch result {
                        case .success:
                            self.sendWorkspace(rootURL: rootURL)
                            self.sendOpenFileResult(path: path, content: "", error: nil)
                            self.sendIssues(count: 0, summary: "ファイルを作成しました。", status: "success", issues: [])
                            if path.lowercased().hasSuffix(".tex")
                                || path.lowercased().hasSuffix(".bib") {
                                self.requestIndex(rootURL: rootURL)
                            }
                        case .failure(let error):
                            let message = error.localizedDescription
                            self.sendIssues(count: 1, summary: message, status: "error", issues: [
                                BuildIssue(severity: .error, message: message, line: nil),
                            ])
                        }
                    }
                }
            }
        }

        private func handleCreateFolder(path: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                    ])
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = self.appModel.workspaceManager.createFolder(rootURL: rootURL, relativePath: path)
                    DispatchQueue.main.async {
                        switch result {
                        case .success:
                            self.sendWorkspace(rootURL: rootURL)
                            self.sendIssues(count: 0, summary: "フォルダを作成しました。", status: "success", issues: [])
                        case .failure(let error):
                            let message = error.localizedDescription
                            self.sendIssues(count: 1, summary: message, status: "error", issues: [
                                BuildIssue(severity: .error, message: message, line: nil),
                            ])
                        }
                    }
                }
            }
        }

        private func handleRevealInFinder(path: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                    ])
                    return
                }
                guard let itemURL = self.resolveItemURL(rootURL: rootURL, relativePath: path) else {
                    self.sendIssues(count: 1, summary: "対象が見つかりません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "対象が見つかりません。", line: nil),
                    ])
                    return
                }
                NSWorkspace.shared.activateFileViewerSelecting([itemURL])
            }
        }

        private func handleOpenInTerminal(path: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                    ])
                    return
                }
                guard let itemURL = self.resolveItemURL(rootURL: rootURL, relativePath: path) else {
                    self.sendIssues(count: 1, summary: "対象が見つかりません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "対象が見つかりません。", line: nil),
                    ])
                    return
                }
                let targetURL: URL
                var isDirectory: ObjCBool = false
                if FileManager.default.fileExists(atPath: itemURL.path, isDirectory: &isDirectory),
                   !isDirectory.boolValue {
                    targetURL = itemURL.deletingLastPathComponent()
                } else {
                    targetURL = itemURL
                }
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                process.arguments = ["-a", "Terminal", targetURL.path]
                do {
                    try process.run()
                } catch {
                    self.sendIssues(count: 1, summary: "ターミナルを開けませんでした。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ターミナルを開けませんでした。", line: nil),
                    ])
                }
            }
        }

        private func handleRenameItem(path: String, newName: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                    ])
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                DispatchQueue.global(qos: .userInitiated).async {
                    let itemURL = self.resolveItemURL(rootURL: rootURL, relativePath: path)
                    var isDirectory: ObjCBool = false
                    if let itemURL {
                        _ = FileManager.default.fileExists(atPath: itemURL.path, isDirectory: &isDirectory)
                    }
                    let result = self.appModel.workspaceManager.renameItem(
                        rootURL: rootURL,
                        relativePath: path,
                        newName: newName
                    )
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let newPath):
                            self.sendRenameResult(oldPath: path, newPath: newPath, isDirectory: isDirectory.boolValue)
                            self.sendWorkspace(rootURL: rootURL)
                            self.sendIssues(count: 0, summary: "名前を変更しました。", status: "success", issues: [])
                            if path.lowercased().hasSuffix(".tex")
                                || path.lowercased().hasSuffix(".bib")
                                || newPath.lowercased().hasSuffix(".tex")
                                || newPath.lowercased().hasSuffix(".bib")
                                || isDirectory.boolValue {
                                self.requestIndex(rootURL: rootURL)
                            }
                        case .failure(let error):
                            let message = error.localizedDescription
                            self.sendIssues(count: 1, summary: message, status: "error", issues: [
                                BuildIssue(severity: .error, message: message, line: nil),
                            ])
                        }
                    }
                }
            }
        }

        private func handleDeleteItem(path: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                    ])
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = self.appModel.workspaceManager.deleteItem(
                        rootURL: rootURL,
                        relativePath: path
                    )
                    DispatchQueue.main.async {
                        switch result {
                        case .success:
                            self.sendWorkspace(rootURL: rootURL)
                            self.sendIssues(count: 0, summary: "削除しました。", status: "success", issues: [])
                            if path.lowercased().hasSuffix(".tex")
                                || path.lowercased().hasSuffix(".bib") {
                                self.requestIndex(rootURL: rootURL)
                            }
                        case .failure(let error):
                            let message = error.localizedDescription
                            self.sendIssues(count: 1, summary: message, status: "error", issues: [
                                BuildIssue(severity: .error, message: message, line: nil),
                            ])
                        }
                    }
                }
            }
        }

        private func handleMoveItem(path: String, destination: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                    ])
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                let sourceURL = self.resolveItemURL(rootURL: rootURL, relativePath: path)
                var isDirectory: ObjCBool = false
                if let sourceURL {
                    _ = FileManager.default.fileExists(atPath: sourceURL.path, isDirectory: &isDirectory)
                }
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = self.appModel.workspaceManager.moveItem(
                        rootURL: rootURL,
                        relativePath: path,
                        destinationFolder: destination
                    )
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let newPath):
                            self.sendRenameResult(oldPath: path, newPath: newPath, isDirectory: isDirectory.boolValue)
                            self.sendWorkspace(rootURL: rootURL)
                            self.sendIssues(count: 0, summary: "移動しました。", status: "success", issues: [])
                            if path.lowercased().hasSuffix(".tex")
                                || path.lowercased().hasSuffix(".bib")
                                || newPath.lowercased().hasSuffix(".tex")
                                || newPath.lowercased().hasSuffix(".bib")
                                || isDirectory.boolValue {
                                self.requestIndex(rootURL: rootURL)
                            }
                        case .failure(let error):
                            let message = error.localizedDescription
                            self.sendIssues(count: 1, summary: message, status: "error", issues: [
                                BuildIssue(severity: .error, message: message, line: nil),
                            ])
                        }
                    }
                }
            }
        }

        private func handleCopyItem(path: String, destination: String) {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                    ])
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = self.appModel.workspaceManager.copyItem(
                        rootURL: rootURL,
                        relativePath: path,
                        destinationFolder: destination
                    )
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let newPath):
                            self.sendWorkspace(rootURL: rootURL)
                            self.sendIssues(count: 0, summary: "コピーしました。", status: "success", issues: [])
                            if path.lowercased().hasSuffix(".tex")
                                || path.lowercased().hasSuffix(".bib")
                                || newPath.lowercased().hasSuffix(".tex")
                                || newPath.lowercased().hasSuffix(".bib") {
                                self.requestIndex(rootURL: rootURL)
                            }
                        case .failure(let error):
                            let message = error.localizedDescription
                            self.sendIssues(count: 1, summary: message, status: "error", issues: [
                                BuildIssue(severity: .error, message: message, line: nil),
                            ])
                        }
                    }
                }
            }
        }

        private func handleUndoFileOperation() {
            guard let webView else { return }
            appModel.workspaceManager.ensureWorkspace(window: webView.window) { [weak self] rootURL in
                guard let self else { return }
                guard let rootURL else {
                    self.sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                        BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                    ])
                    return
                }
                self.updateWorkspaceIfNeeded(rootURL: rootURL)
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = self.appModel.workspaceManager.undoLastOperation(rootURL: rootURL)
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let operation):
                            if let operation {
                                if operation.kind == .move,
                                   let oldPath = operation.toPath {
                                    self.sendRenameResult(
                                        oldPath: oldPath,
                                        newPath: operation.fromPath,
                                        isDirectory: operation.isDirectory
                                    )
                                }
                                self.sendWorkspace(rootURL: rootURL)
                                self.sendIssues(count: 0, summary: "操作を戻しました。", status: "success", issues: [])
                                if operation.affectsIndex {
                                    self.requestIndex(rootURL: rootURL)
                                }
                            } else {
                                self.sendIssues(count: 0, summary: "戻す操作はありません。", status: "info", issues: [])
                            }
                        case .failure(let error):
                            let message = error.localizedDescription
                            self.sendIssues(count: 1, summary: message, status: "error", issues: [
                                BuildIssue(severity: .error, message: message, line: nil),
                            ])
                        }
                    }
                }
            }
        }

        private func handleSetRoot(path: String) {
            guard let rootURL = appModel.workspaceManager.rootURL else {
                sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                    BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                ])
                return
            }
            let result = appModel.workspaceManager.setRootFile(rootURL: rootURL, path: path)
            switch result {
            case .success:
                sendWorkspace(rootURL: rootURL)
                sendIssues(count: 0, summary: "メインTeXを更新しました。", status: "success", issues: [])
            case .failure(let error):
                let message = error.localizedDescription
                sendIssues(count: 1, summary: message, status: "error", issues: [
                    BuildIssue(severity: .error, message: message, line: nil),
                ])
            }
        }

        private func handleDetectRoot() {
            guard let rootURL = appModel.workspaceManager.rootURL else {
                sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                    BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                ])
                return
            }
            let result = appModel.workspaceManager.clearRootOverride(rootURL: rootURL)
            switch result {
            case .success:
                sendWorkspace(rootURL: rootURL)
                sendIssues(count: 0, summary: "メインTeXを自動検出しました。", status: "success", issues: [])
            case .failure(let error):
                let message = error.localizedDescription
                sendIssues(count: 1, summary: message, status: "error", issues: [
                    BuildIssue(severity: .error, message: message, line: nil),
                ])
            }
        }

        private func handleIndexRequest() {
            guard let rootURL = appModel.workspaceManager.rootURL else { return }
            requestIndex(rootURL: rootURL)
        }

        private func handleLoadBlocks() {
            guard let rootURL = appModel.workspaceManager.rootURL else {
                sendBlocks([])
                return
            }
            appModel.blocksStore.load(rootURL: rootURL) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let blocks):
                    self.sendBlocks(blocks)
                case .failure(let error):
                    let message = error.localizedDescription
                    self.sendBlocks([])
                    self.sendIssues(count: 1, summary: message, status: "error", issues: [
                        BuildIssue(severity: .error, message: message, line: nil),
                    ])
                }
            }
        }

        private func handleSaveBlocks(_ blocksPayload: [[String: Any]]) {
            guard let rootURL = appModel.workspaceManager.rootURL else {
                sendIssues(count: 1, summary: "ワークスペースが選択されていません。", status: "error", issues: [
                    BuildIssue(severity: .error, message: "ワークスペースが選択されていません。", line: nil),
                ])
                return
            }
            do {
                let data = try JSONSerialization.data(withJSONObject: blocksPayload, options: [])
                let blocks = try JSONDecoder().decode([BlockMeta].self, from: data)
                appModel.blocksStore.save(rootURL: rootURL, blocks: blocks) { [weak self] result in
                    guard let self else { return }
                    switch result {
                    case .success:
                        self.sendBlocks(blocks)
                    case .failure(let error):
                        let message = error.localizedDescription
                        self.sendIssues(count: 1, summary: message, status: "error", issues: [
                            BuildIssue(severity: .error, message: message, line: nil),
                        ])
                    }
                }
            } catch {
                let message = error.localizedDescription
                sendIssues(count: 1, summary: message, status: "error", issues: [
                    BuildIssue(severity: .error, message: message, line: nil),
                ])
            }
        }

        private func handleSearch(query: String) {
            guard let rootURL = appModel.workspaceManager.rootURL else {
                sendSearch(query: query, results: [], message: "ワークスペースが選択されていません。")
                return
            }
            appModel.searchService.search(rootURL: rootURL, query: query) { [weak self] results in
                self?.sendSearch(query: query, results: results, message: nil)
            }
        }

        private func handleGitStatus() {
            guard let rootURL = appModel.workspaceManager.rootURL else {
                sendGitStatus(entries: [], message: "ワークスペースが選択されていません。")
                return
            }
            appModel.gitService.status(rootURL: rootURL) { [weak self] snapshot in
                self?.sendGitStatus(entries: snapshot.entries, message: snapshot.message)
            }
        }

        private func requestIndex(rootURL: URL) {
            appModel.indexerService.requestIndex(rootURL: rootURL) { [weak self] snapshot in
                guard let self else { return }
                guard self.currentWorkspacePath == rootURL.path else { return }
                self.sendIndex(snapshot)
            }
        }

        private func sendBuildState(_ state: String, message: String?) {
            var payload: [String: Any] = ["state": state]
            if let message {
                payload["message"] = message
            }
            callJavaScript(function: "window.tex180SetBuildState", payload: payload)
        }

        private func sendIssues(count: Int, summary: String, status: String, issues: [BuildIssue]) {
            let payload: [String: Any] = [
                "count": count,
                "summary": summary,
                "status": status,
                "issues": encodeIssues(issues),
            ]
            callJavaScript(function: "window.tex180UpdateIssues", payload: payload)
        }

        private func sendWorkspace(rootURL: URL) {
            DispatchQueue.global(qos: .userInitiated).async {
                let result = self.appModel.workspaceManager.listFiles(rootURL: rootURL)
                let folderResult = self.appModel.workspaceManager.listFolders(rootURL: rootURL)
                let rootInfo = self.appModel.workspaceManager.rootInfo(rootURL: rootURL)
                DispatchQueue.main.async {
                    var files: [String] = []
                    var folders: [String] = []
                    var errorMessage: String? = nil
                    switch result {
                    case .success(let fileList):
                        files = fileList
                    case .failure(let error):
                        errorMessage = error.localizedDescription
                    }
                    switch folderResult {
                    case .success(let list):
                        folders = list
                    case .failure(let error):
                        if errorMessage == nil {
                            errorMessage = error.localizedDescription
                        }
                    }
                    let payload: [String: Any] = [
                        "rootName": rootURL.lastPathComponent,
                        "rootPath": rootURL.path,
                        "files": files,
                        "folders": folders,
                        "rootFile": rootInfo?.path ?? "",
                        "rootSource": rootInfo?.source.rawValue ?? "",
                    ]
                    self.callJavaScript(function: "window.tex180UpdateWorkspace", payload: payload)
                    if let errorMessage {
                        self.sendIssues(count: 1, summary: errorMessage, status: "error", issues: [
                            BuildIssue(severity: .error, message: errorMessage, line: nil),
                        ])
                    }
                }
            }
        }

        private func updateWorkspaceIfNeeded(rootURL: URL, force: Bool = false) {
            let path = rootURL.path
            if !force && currentWorkspacePath == path {
                return
            }
            currentWorkspacePath = path
            sendWorkspace(rootURL: rootURL)
        }

        private func sendOpenFileResult(path: String, content: String?, error: String?) {
            var payload: [String: Any] = ["path": path]
            if let content {
                payload["content"] = content
            }
            if let error {
                payload["error"] = error
            }
            callJavaScript(function: "window.tex180OpenFileResult", payload: payload)
        }

        private func sendRenameResult(oldPath: String, newPath: String, isDirectory: Bool) {
            let payload: [String: Any] = [
                "oldPath": oldPath,
                "newPath": newPath,
                "isDirectory": isDirectory,
            ]
            callJavaScript(function: "window.tex180RenameResult", payload: payload)
        }

        private func resolveItemURL(rootURL: URL, relativePath: String) -> URL? {
            let url = rootURL.appendingPathComponent(relativePath)
            let rootPath = rootURL.standardizedFileURL.path
            let filePath = url.standardizedFileURL.path
            guard filePath == rootPath || filePath.hasPrefix(rootPath + "/") else {
                return nil
            }
            return url
        }

        private func sendSaveResult(path: String, ok: Bool, message: String?) {
            var payload: [String: Any] = ["path": path, "ok": ok]
            if let message {
                payload["error"] = message
            }
            callJavaScript(function: "window.tex180SaveResult", payload: payload)
        }

        private func sendIndex(_ snapshot: IndexSnapshot) {
            let payload: [String: Any] = [
                "labels": encodeIndexSymbols(snapshot.labels),
                "references": encodeIndexSymbols(snapshot.references),
                "citations": encodeIndexSymbols(snapshot.citations),
                "sections": encodeSections(snapshot.sections),
                "figures": encodeIndexSymbols(snapshot.figures),
                "tables": encodeIndexSymbols(snapshot.tables),
                "todos": encodeIndexSymbols(snapshot.todos),
            ]
            callJavaScript(function: "window.tex180UpdateIndex", payload: payload)
        }

        private func sendBlocks(_ blocks: [BlockMeta]) {
            let payload: [String: Any] = [
                "blocks": encodeBlocks(blocks),
            ]
            callJavaScript(function: "window.tex180UpdateBlocks", payload: payload)
        }

        private func sendSearch(query: String, results: [SearchResult], message: String?) {
            var payload: [String: Any] = [
                "query": query,
                "results": encodeSearchResults(results),
            ]
            if let message {
                payload["message"] = message
            }
            callJavaScript(function: "window.tex180UpdateSearch", payload: payload)
        }

        private func sendGitStatus(entries: [GitStatusEntry], message: String?) {
            var payload: [String: Any] = [
                "entries": encodeGitEntries(entries),
            ]
            if let message {
                payload["message"] = message
            }
            callJavaScript(function: "window.tex180UpdateGit", payload: payload)
        }

        private func encodeIssues(_ issues: [BuildIssue]) -> [[String: Any]] {
            issues.map { issue in
                var payload: [String: Any] = [
                    "severity": issue.severity.rawValue,
                    "message": issue.message,
                ]
                if let line = issue.line {
                    payload["line"] = line
                }
                return payload
            }
        }

        private func encodeIndexSymbols(_ symbols: [IndexSymbol]) -> [[String: Any]] {
            symbols.map { symbol in
                [
                    "key": symbol.key,
                    "path": symbol.path,
                    "line": symbol.line,
                ]
            }
        }

        private func encodeBlocks(_ blocks: [BlockMeta]) -> [[String: Any]] {
            guard let data = try? JSONEncoder().encode(blocks),
                  let json = try? JSONSerialization.jsonObject(with: data, options: []),
                  let array = json as? [[String: Any]] else {
                return []
            }
            return array
        }

        private func encodeSections(_ sections: [SectionSymbol]) -> [[String: Any]] {
            sections.map { section in
                [
                    "title": section.title,
                    "path": section.path,
                    "line": section.line,
                    "level": section.level,
                ]
            }
        }

        private func encodeSearchResults(_ results: [SearchResult]) -> [[String: Any]] {
            results.map { result in
                [
                    "path": result.path,
                    "line": result.line,
                    "preview": result.preview,
                ]
            }
        }

        private func encodeGitEntries(_ entries: [GitStatusEntry]) -> [[String: Any]] {
            entries.map { entry in
                [
                    "status": entry.status,
                    "path": entry.path,
                ]
            }
        }

        private func callJavaScript(function: String, payload: [String: Any]) {
            guard let webView else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else {
                return
            }
            let script = "\(function)(\(json));"
            DispatchQueue.main.async {
                webView.evaluateJavaScript(script, completionHandler: nil)
            }
        }
    }
}
