//
//  WorkspaceManager.swift
//  tex180
//
//  Created by Codex.
//

import AppKit
import Foundation

final class WorkspaceManager {
    enum RootSource: String {
        case auto
        case manual
    }

    enum ProjectTemplate: String, CaseIterable {
        case paper
        case lecture
    }

    struct RootFileInfo {
        let path: String
        let source: RootSource
    }

    private struct ProjectSettings: Codable {
        let rootFile: String?
    }

    struct FileOperation {
        enum Kind {
            case move
            case delete
        }

        let kind: Kind
        let fromPath: String
        let toPath: String?
        let isDirectory: Bool
        let affectsIndex: Bool
        let trashedURL: URL?
    }

    private var _rootURL: URL?
    private var _isAccessingSecurityScope = false

    private(set) var rootURL: URL? {
        get { _rootURL }
        set {
            // Stop previous access if any
            if _isAccessingSecurityScope, let oldURL = _rootURL {
                oldURL.stopAccessingSecurityScopedResource()
                _isAccessingSecurityScope = false
            }
            _rootURL = newValue
            // Start security-scoped access for new URL
            if let url = newValue {
                _isAccessingSecurityScope = url.startAccessingSecurityScopedResource()
            }
        }
    }
    private var rootFileInfo: RootFileInfo?
    private var rootInfoRootPath: String?
    private var undoStack: [FileOperation] = []

    deinit {
        if _isAccessingSecurityScope, let url = _rootURL {
            url.stopAccessingSecurityScopedResource()
        }
    }

    func ensureWorkspace(window: NSWindow?, completion: @escaping (URL?) -> Void) {
        if let rootURL {
            completion(rootURL)
            return
        }
        selectWorkspace(window: window, completion: completion)
    }

    func selectWorkspace(window: NSWindow?, completion: @escaping (URL?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "プロジェクトを選択"
        panel.message = "LaTeXプロジェクトのフォルダを選択してください。"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "選択"
        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .OK, let url = panel.url else {
                completion(nil)
                return
            }
            self?.rootURL = url
            self?.undoStack.removeAll()
            completion(url)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: handler)
        } else {
            handler(panel.runModal())
        }
    }

    func createNewProject(
        window: NSWindow?,
        template: ProjectTemplate,
        completion: @escaping (Result<URL, Error>) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.title = "新規プロジェクト"
        panel.message = "プロジェクト用フォルダを作成または選択してください。"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "作成"
        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .OK, let url = panel.url else {
                completion(.failure(WorkspaceError.cancelled))
                return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                let result = self?.initializeProject(at: url, template: template)
                    ?? .failure(WorkspaceError.unknown)
                DispatchQueue.main.async {
                    switch result {
                    case .success:
                        self?.rootURL = url
                        self?.undoStack.removeAll()
                        completion(.success(url))
                    case .failure(let error):
                        completion(.failure(error))
                    }
                }
            }
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: handler)
        } else {
            handler(panel.runModal())
        }
    }

    func rootInfo(rootURL: URL) -> RootFileInfo? {
        if rootInfoRootPath != rootURL.path {
            rootInfoRootPath = rootURL.path
            rootFileInfo = nil
        }
        if let rootFileInfo {
            return rootFileInfo
        }
        let result: Result<RootFileInfo?, Error> = withScopedAccess(rootURL: rootURL) {
            if let settings = loadSettings(rootURL: rootURL),
               let rootFile = settings.rootFile,
               let fileURL = resolveFileURL(rootURL: rootURL, relativePath: rootFile),
               FileManager.default.fileExists(atPath: fileURL.path) {
                return RootFileInfo(path: rootFile, source: .manual)
            }
            if let autoRoot = detectRootFile(rootURL: rootURL) {
                return RootFileInfo(path: autoRoot, source: .auto)
            }
            return nil
        }
        switch result {
        case .success(let info):
            rootFileInfo = info
            return info
        case .failure:
            return nil
        }
    }

    func setRootFile(rootURL: URL, path: String?) -> Result<RootFileInfo?, Error> {
        let trimmed = (path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return clearRootOverride(rootURL: rootURL)
        }
        return withScopedAccess(rootURL: rootURL) {
            guard let fileURL = resolveFileURL(rootURL: rootURL, relativePath: trimmed) else {
                throw WorkspaceError.invalidPath
            }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory),
                  !isDirectory.boolValue else {
                throw WorkspaceError.invalidPath
            }
            guard fileURL.pathExtension.lowercased() == "tex" else {
                throw WorkspaceError.invalidPath
            }
            let info = RootFileInfo(path: trimmed, source: .manual)
            rootFileInfo = info
            rootInfoRootPath = rootURL.path
            let settings = ProjectSettings(rootFile: trimmed)
            try saveSettings(rootURL: rootURL, settings: settings).get()
            return info
        }
    }

    func clearRootOverride(rootURL: URL) -> Result<RootFileInfo?, Error> {
        withScopedAccess(rootURL: rootURL) {
            rootInfoRootPath = rootURL.path
            let autoRoot = detectRootFile(rootURL: rootURL)
            if let autoRoot {
                rootFileInfo = RootFileInfo(path: autoRoot, source: .auto)
            } else {
                rootFileInfo = nil
            }
            _ = try removeSettings(rootURL: rootURL).get()
            return rootFileInfo
        }
    }

    func listFiles(rootURL: URL) -> Result<[String], Error> {
        withScopedAccess(rootURL: rootURL) {
            let ignoredDirectories: Set<String> = [
                ".git",
                ".tex180",
                ".swiftpm",
                "node_modules",
                "DerivedData",
                "build",
                "Resources",
                "tex180.xcodeproj",
            ]
            var results: [String] = []
            let rootPath = rootURL.standardizedFileURL.path
            guard let enumerator = FileManager.default.enumerator(
                at: rootURL,
                includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .nameKey],
                options: [.skipsHiddenFiles]
            ) else {
                return []
            }
            for case let fileURL as URL in enumerator {
                guard results.count < 5000 else { break }
                let values: URLResourceValues
                do {
                    values = try fileURL.resourceValues(
                        forKeys: [.isDirectoryKey, .isRegularFileKey, .nameKey]
                    )
                } catch {
                    continue
                }
                if values.isDirectory == true {
                    if let name = values.name, ignoredDirectories.contains(name) {
                        enumerator.skipDescendants()
                    }
                    continue
                }
                guard values.isRegularFile == true else { continue }
                let filePath = fileURL.standardizedFileURL.path
                guard filePath.hasPrefix(rootPath + "/") else { continue }
                let relativePath = String(filePath.dropFirst(rootPath.count + 1))
                results.append(relativePath)
            }
            return results.sorted()
        }
    }

    func listFolders(rootURL: URL) -> Result<[String], Error> {
        withScopedAccess(rootURL: rootURL) {
            let ignoredDirectories: Set<String> = [
                ".git",
                ".tex180",
                ".swiftpm",
                "node_modules",
                "DerivedData",
                "build",
                "Resources",
                "tex180.xcodeproj",
            ]
            var results: [String] = []
            let rootPath = rootURL.standardizedFileURL.path
            guard let enumerator = FileManager.default.enumerator(
                at: rootURL,
                includingPropertiesForKeys: [.isDirectoryKey, .nameKey],
                options: [.skipsHiddenFiles]
            ) else {
                return []
            }
            for case let fileURL as URL in enumerator {
                guard results.count < 5000 else { break }
                let values: URLResourceValues
                do {
                    values = try fileURL.resourceValues(forKeys: [.isDirectoryKey, .nameKey])
                } catch {
                    continue
                }
                guard values.isDirectory == true else { continue }
                if let name = values.name, ignoredDirectories.contains(name) {
                    enumerator.skipDescendants()
                    continue
                }
                let filePath = fileURL.standardizedFileURL.path
                guard filePath.hasPrefix(rootPath + "/") else { continue }
                let relativePath = String(filePath.dropFirst(rootPath.count + 1))
                results.append(relativePath)
            }
            return results.sorted()
        }
    }

    func readFile(rootURL: URL, relativePath: String) -> Result<String, Error> {
        withScopedAccess(rootURL: rootURL) {
            guard let fileURL = resolveFileURL(rootURL: rootURL, relativePath: relativePath) else {
                throw WorkspaceError.invalidPath
            }
            let data = try Data(contentsOf: fileURL)
            guard let content = String(data: data, encoding: .utf8) else {
                throw WorkspaceError.invalidEncoding
            }
            return content
        }
    }

    func writeFile(rootURL: URL, relativePath: String, content: String) -> Result<Void, Error> {
        withScopedAccess(rootURL: rootURL) {
            guard let fileURL = resolveFileURL(rootURL: rootURL, relativePath: relativePath) else {
                throw WorkspaceError.invalidPath
            }
            guard let data = content.data(using: .utf8) else {
                throw WorkspaceError.invalidEncoding
            }
            try data.write(to: fileURL, options: .atomic)
        }
    }

    func createFile(rootURL: URL, relativePath: String) -> Result<Void, Error> {
        withScopedAccess(rootURL: rootURL) {
            guard let fileURL = resolveFileURL(rootURL: rootURL, relativePath: relativePath) else {
                throw WorkspaceError.invalidPath
            }
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory) {
                throw WorkspaceError.alreadyExists
            }
            let parentURL = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parentURL, withIntermediateDirectories: true, attributes: nil)
            try Data().write(to: fileURL, options: .atomic)
        }
    }

    func createFolder(rootURL: URL, relativePath: String) -> Result<Void, Error> {
        withScopedAccess(rootURL: rootURL) {
            guard let folderURL = resolveFileURL(rootURL: rootURL, relativePath: relativePath) else {
                throw WorkspaceError.invalidPath
            }
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: folderURL.path, isDirectory: &isDirectory) {
                throw WorkspaceError.alreadyExists
            }
            try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true, attributes: nil)
        }
    }

    func renameItem(rootURL: URL, relativePath: String, newName: String) -> Result<String, Error> {
        withScopedAccess(rootURL: rootURL) {
            let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !trimmed.contains("/") else {
                throw WorkspaceError.invalidName
            }
            guard let itemURL = resolveFileURL(rootURL: rootURL, relativePath: relativePath) else {
                throw WorkspaceError.invalidPath
            }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: itemURL.path, isDirectory: &isDirectory) else {
                throw WorkspaceError.notFound
            }
            let parentURL = itemURL.deletingLastPathComponent()
            let targetURL = parentURL.appendingPathComponent(trimmed)
            if FileManager.default.fileExists(atPath: targetURL.path) {
                throw WorkspaceError.alreadyExists
            }
            try FileManager.default.moveItem(at: itemURL, to: targetURL)
            let rootPath = rootURL.standardizedFileURL.path
            let parentPath = parentURL.standardizedFileURL.path
            let parentRelative = parentPath == rootPath
                ? ""
                : String(parentPath.dropFirst(rootPath.count + 1))
            let newRelativePath = parentRelative.isEmpty
                ? trimmed
                : "\(parentRelative)/\(trimmed)"
            updateRootOverrideAfterRename(
                rootURL: rootURL,
                oldPath: relativePath,
                newPath: newRelativePath
            )
            return newRelativePath
        }
    }

    func moveItem(rootURL: URL, relativePath: String, destinationFolder: String) -> Result<String, Error> {
        withScopedAccess(rootURL: rootURL) {
            let trimmed = relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                throw WorkspaceError.invalidPath
            }
            guard let sourceURL = resolveFileURL(rootURL: rootURL, relativePath: trimmed) else {
                throw WorkspaceError.invalidPath
            }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: sourceURL.path, isDirectory: &isDirectory) else {
                throw WorkspaceError.notFound
            }

            let destinationTrimmed = destinationFolder.trimmingCharacters(in: .whitespacesAndNewlines)
            let destinationURL: URL
            if destinationTrimmed.isEmpty {
                destinationURL = rootURL
            } else {
                guard let resolvedDestination = resolveFileURL(
                    rootURL: rootURL,
                    relativePath: destinationTrimmed
                ) else {
                    throw WorkspaceError.invalidPath
                }
                var destinationIsDir: ObjCBool = false
                guard FileManager.default.fileExists(
                    atPath: resolvedDestination.path,
                    isDirectory: &destinationIsDir
                ),
                      destinationIsDir.boolValue else {
                    throw WorkspaceError.invalidMove
                }
                destinationURL = resolvedDestination
            }

            let sourcePath = sourceURL.standardizedFileURL.path
            let destinationPath = destinationURL.standardizedFileURL.path
            if isDirectory.boolValue {
                if destinationPath == sourcePath || destinationPath.hasPrefix(sourcePath + "/") {
                    throw WorkspaceError.invalidMove
                }
            }

            let targetURL = destinationURL.appendingPathComponent(sourceURL.lastPathComponent)
            if targetURL.standardizedFileURL.path == sourcePath {
                return trimmed
            }
            if FileManager.default.fileExists(atPath: targetURL.path) {
                throw WorkspaceError.alreadyExists
            }

            try FileManager.default.moveItem(at: sourceURL, to: targetURL)

            let rootPath = rootURL.standardizedFileURL.path
            let newPath = targetURL.standardizedFileURL.path
            guard newPath.hasPrefix(rootPath + "/") else {
                throw WorkspaceError.invalidMove
            }
            let newRelativePath = String(newPath.dropFirst(rootPath.count + 1))
            updateRootOverrideAfterRename(
                rootURL: rootURL,
                oldPath: trimmed,
                newPath: newRelativePath
            )
            let affectsIndex = isDirectory.boolValue
                || trimmed.lowercased().hasSuffix(".tex")
                || trimmed.lowercased().hasSuffix(".bib")
                || newRelativePath.lowercased().hasSuffix(".tex")
                || newRelativePath.lowercased().hasSuffix(".bib")
            undoStack.append(
                FileOperation(
                    kind: .move,
                    fromPath: trimmed,
                    toPath: newRelativePath,
                    isDirectory: isDirectory.boolValue,
                    affectsIndex: affectsIndex,
                    trashedURL: nil
                )
            )
            return newRelativePath
        }
    }

    func copyItem(rootURL: URL, relativePath: String, destinationFolder: String) -> Result<String, Error> {
        withScopedAccess(rootURL: rootURL) {
            let trimmed = relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                throw WorkspaceError.invalidPath
            }
            guard let sourceURL = resolveFileURL(rootURL: rootURL, relativePath: trimmed) else {
                throw WorkspaceError.invalidPath
            }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: sourceURL.path, isDirectory: &isDirectory) else {
                throw WorkspaceError.notFound
            }

            let destinationTrimmed = destinationFolder.trimmingCharacters(in: .whitespacesAndNewlines)
            let destinationURL: URL
            if destinationTrimmed.isEmpty {
                destinationURL = rootURL
            } else {
                guard let resolvedDestination = resolveFileURL(
                    rootURL: rootURL,
                    relativePath: destinationTrimmed
                ) else {
                    throw WorkspaceError.invalidPath
                }
                var destinationIsDir: ObjCBool = false
                guard FileManager.default.fileExists(
                    atPath: resolvedDestination.path,
                    isDirectory: &destinationIsDir
                ),
                      destinationIsDir.boolValue else {
                    throw WorkspaceError.invalidMove
                }
                destinationURL = resolvedDestination
            }

            let targetURL = destinationURL.appendingPathComponent(sourceURL.lastPathComponent)
            if FileManager.default.fileExists(atPath: targetURL.path) {
                throw WorkspaceError.alreadyExists
            }
            try FileManager.default.copyItem(at: sourceURL, to: targetURL)

            let rootPath = rootURL.standardizedFileURL.path
            let newPath = targetURL.standardizedFileURL.path
            guard newPath.hasPrefix(rootPath + "/") else {
                throw WorkspaceError.invalidMove
            }
            let newRelativePath = String(newPath.dropFirst(rootPath.count + 1))
            return newRelativePath
        }
    }

    func deleteItem(rootURL: URL, relativePath: String) -> Result<Void, Error> {
        withScopedAccess(rootURL: rootURL) {
            let trimmed = relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                throw WorkspaceError.invalidPath
            }
            guard let itemURL = resolveFileURL(rootURL: rootURL, relativePath: trimmed) else {
                throw WorkspaceError.invalidPath
            }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: itemURL.path, isDirectory: &isDirectory) else {
                throw WorkspaceError.notFound
            }
            let affectsIndex = isDirectory.boolValue
                || trimmed.lowercased().hasSuffix(".tex")
                || trimmed.lowercased().hasSuffix(".bib")
            var trashedURL: URL?
            if #available(macOS 10.13, *) {
                do {
                    var resultingURL: NSURL?
                    try FileManager.default.trashItem(at: itemURL, resultingItemURL: &resultingURL)
                    trashedURL = resultingURL as URL?
                } catch {
                    trashedURL = try moveToInternalTrash(rootURL: rootURL, itemURL: itemURL)
                }
            } else {
                trashedURL = try moveToInternalTrash(rootURL: rootURL, itemURL: itemURL)
            }
            undoStack.append(
                FileOperation(
                    kind: .delete,
                    fromPath: trimmed,
                    toPath: nil,
                    isDirectory: isDirectory.boolValue,
                    affectsIndex: affectsIndex,
                    trashedURL: trashedURL
                )
            )
            updateRootOverrideAfterDelete(rootURL: rootURL, deletedPath: trimmed)
        }
    }

    func undoLastOperation(rootURL: URL) -> Result<FileOperation?, Error> {
        withScopedAccess(rootURL: rootURL) {
            guard let operation = undoStack.popLast() else {
                return nil
            }
            switch operation.kind {
            case .move:
                guard let toPath = operation.toPath else {
                    throw WorkspaceError.invalidMove
                }
                guard let sourceURL = resolveFileURL(rootURL: rootURL, relativePath: toPath),
                      let targetURL = resolveFileURL(rootURL: rootURL, relativePath: operation.fromPath) else {
                    throw WorkspaceError.invalidPath
                }
                if FileManager.default.fileExists(atPath: targetURL.path) {
                    throw WorkspaceError.alreadyExists
                }
                let parentURL = targetURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(
                    at: parentURL,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
                try FileManager.default.moveItem(at: sourceURL, to: targetURL)
                updateRootOverrideAfterRename(
                    rootURL: rootURL,
                    oldPath: toPath,
                    newPath: operation.fromPath
                )
                return operation
            case .delete:
                guard let trashedURL = operation.trashedURL,
                      let targetURL = resolveFileURL(rootURL: rootURL, relativePath: operation.fromPath) else {
                    throw WorkspaceError.invalidMove
                }
                if FileManager.default.fileExists(atPath: targetURL.path) {
                    throw WorkspaceError.alreadyExists
                }
                let parentURL = targetURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(
                    at: parentURL,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
                try FileManager.default.moveItem(at: trashedURL, to: targetURL)
                return operation
            }
        }
    }

    enum WorkspaceError: LocalizedError, Equatable {
        case invalidPath
        case invalidName
        case invalidEncoding
        case alreadyExists
        case notFound
        case notEmpty
        case invalidMove
        case cancelled
        case unknown

        var errorDescription: String? {
            switch self {
            case .invalidPath:
                return "不正なパスです。"
            case .invalidName:
                return "名前が不正です。"
            case .invalidEncoding:
                return "UTF-8以外の文字コードです。"
            case .alreadyExists:
                return "すでに存在します。"
            case .notFound:
                return "見つかりません。"
            case .notEmpty:
                return "フォルダが空ではありません。"
            case .invalidMove:
                return "移動先が不正です。"
            case .cancelled:
                return "キャンセルしました。"
            case .unknown:
                return "プロジェクトの作成に失敗しました。"
            }
        }
    }

    private func resolveFileURL(rootURL: URL, relativePath: String) -> URL? {
        let fileURL = rootURL.appendingPathComponent(relativePath)
        let rootPath = rootURL.standardizedFileURL.path
        let filePath = fileURL.standardizedFileURL.path
        guard filePath == rootPath || filePath.hasPrefix(rootPath + "/") else {
            return nil
        }
        return fileURL
    }

    private func updateRootOverrideAfterRename(rootURL: URL, oldPath: String, newPath: String) {
        guard rootInfoRootPath == rootURL.path,
              let currentRootInfo = rootFileInfo,
              currentRootInfo.source == .manual else {
            return
        }
        let currentRoot = currentRootInfo.path
        if currentRoot == oldPath {
            let updated = RootFileInfo(path: newPath, source: .manual)
            self.rootFileInfo = updated
            let settings = ProjectSettings(rootFile: newPath)
            _ = try? saveSettings(rootURL: rootURL, settings: settings).get()
            return
        }
        let prefix = oldPath + "/"
        guard currentRoot.hasPrefix(prefix) else {
            return
        }
        let suffix = String(currentRoot.dropFirst(prefix.count))
        let updatedPath = newPath + "/" + suffix
        let updated = RootFileInfo(path: updatedPath, source: .manual)
        self.rootFileInfo = updated
        let settings = ProjectSettings(rootFile: updatedPath)
        _ = try? saveSettings(rootURL: rootURL, settings: settings).get()
    }

    private func updateRootOverrideAfterDelete(rootURL: URL, deletedPath: String) {
        guard rootInfoRootPath == rootURL.path,
              let currentRootInfo = rootFileInfo,
              currentRootInfo.source == .manual else {
            return
        }
        let currentRoot = currentRootInfo.path
        if currentRoot == deletedPath || currentRoot.hasPrefix(deletedPath + "/") {
            self.rootFileInfo = nil
            _ = try? removeSettings(rootURL: rootURL).get()
        }
    }

    private func moveToInternalTrash(rootURL: URL, itemURL: URL) throws -> URL {
        let trashDirectory = rootURL
            .appendingPathComponent(".tex180")
            .appendingPathComponent(".trash")
        try FileManager.default.createDirectory(
            at: trashDirectory,
            withIntermediateDirectories: true,
            attributes: nil
        )
        let baseName = itemURL.lastPathComponent
        var candidateURL = trashDirectory.appendingPathComponent("\(UUID().uuidString)-\(baseName)")
        var attempts = 0
        while FileManager.default.fileExists(atPath: candidateURL.path) && attempts < 5 {
            attempts += 1
            candidateURL = trashDirectory.appendingPathComponent("\(UUID().uuidString)-\(baseName)")
        }
        if FileManager.default.fileExists(atPath: candidateURL.path) {
            throw WorkspaceError.alreadyExists
        }
        try FileManager.default.moveItem(at: itemURL, to: candidateURL)
        return candidateURL
    }

    private func initializeProject(at rootURL: URL, template: ProjectTemplate) -> Result<Void, Error> {
        withScopedAccess(rootURL: rootURL) {
            if !FileManager.default.fileExists(atPath: rootURL.path) {
                try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true, attributes: nil)
            }
            let contents = try FileManager.default.contentsOfDirectory(
                at: rootURL,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )
            if !contents.isEmpty {
                throw WorkspaceError.notEmpty
            }
            let mainTex = templateContent(template: template)
            let mainTexURL = rootURL.appendingPathComponent("main.tex")
            guard let mainData = mainTex.data(using: .utf8) else {
                throw WorkspaceError.invalidEncoding
            }
            try mainData.write(to: mainTexURL, options: .atomic)
        }
    }

    private func templateContent(template: ProjectTemplate) -> String {
        switch template {
        case .paper:
            return [
                "\\documentclass{article}",
                "\\title{論文タイトル}",
                "\\author{著者名}",
                "\\date{\\today}",
                "",
                "\\begin{document}",
                "\\maketitle",
                "",
                "\\begin{abstract}",
                "概要をここに書きます。",
                "\\end{abstract}",
                "",
                "\\section{はじめに}",
                "ここから本文を開始します。",
                "",
                "\\section{結論}",
                "結論をここに書きます。",
                "",
                "\\end{document}",
                "",
            ].joined(separator: "\n")
        case .lecture:
            return [
                "\\documentclass{article}",
                "\\title{講義ノート}",
                "\\author{講師名}",
                "\\date{\\today}",
                "",
                "\\begin{document}",
                "\\maketitle",
                "",
                "\\section{目的}",
                "この講義の目的を書きます。",
                "",
                "\\section{内容}",
                "\\subsection{ポイント1}",
                "本文をここに書きます。",
                "",
                "\\subsection{ポイント2}",
                "本文をここに書きます。",
                "",
                "\\section{まとめ}",
                "まとめを書きます。",
                "",
                "\\end{document}",
                "",
            ].joined(separator: "\n")
        }
    }

    private func detectRootFile(rootURL: URL) -> String? {
        let mainURL = rootURL.appendingPathComponent("main.tex")
        if FileManager.default.fileExists(atPath: mainURL.path) {
            return "main.tex"
        }

        let ignoredDirectories: Set<String> = [
            ".git",
            ".tex180",
            ".swiftpm",
            "node_modules",
            "DerivedData",
            "build",
            "Resources",
            "tex180.xcodeproj",
        ]

        struct Candidate {
            let path: String
            let score: Int
            let depth: Int
        }

        var candidates: [Candidate] = []
        let rootPath = rootURL.standardizedFileURL.path

        guard let enumerator = FileManager.default.enumerator(
            at: rootURL,
            includingPropertiesForKeys: [.isDirectoryKey, .nameKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }

        for case let fileURL as URL in enumerator {
            let values: URLResourceValues
            do {
                values = try fileURL.resourceValues(forKeys: [.isDirectoryKey, .nameKey])
            } catch {
                continue
            }
            if values.isDirectory == true {
                if let name = values.name, ignoredDirectories.contains(name) {
                    enumerator.skipDescendants()
                }
                continue
            }

            guard fileURL.pathExtension.lowercased() == "tex" else { continue }
            guard let content = try? String(contentsOf: fileURL, encoding: .utf8) else {
                continue
            }
            let filePath = fileURL.standardizedFileURL.path
            guard filePath.hasPrefix(rootPath + "/") else { continue }
            let relativePath = String(filePath.dropFirst(rootPath.count + 1))
            let lowerName = fileURL.lastPathComponent.lowercased()

            var score = 0
            if content.contains("\\documentclass") { score += 3 }
            if content.contains("\\begin{document}") { score += 2 }
            if content.contains("\\end{document}") { score += 1 }
            if [
                "main.tex",
                "root.tex",
                "paper.tex",
                "thesis.tex",
                "report.tex",
                "lecture.tex",
                "notes.tex",
            ].contains(lowerName) {
                score += 2
            }

            guard score > 0 else { continue }
            let depth = relativePath.split(separator: "/").count
            candidates.append(Candidate(path: relativePath, score: score, depth: depth))
        }

        guard !candidates.isEmpty else { return nil }
        candidates.sort { lhs, rhs in
            if lhs.score != rhs.score {
                return lhs.score > rhs.score
            }
            if lhs.depth != rhs.depth {
                return lhs.depth < rhs.depth
            }
            return lhs.path.localizedCaseInsensitiveCompare(rhs.path) == .orderedAscending
        }
        return candidates.first?.path
    }

    private func loadSettings(rootURL: URL) -> ProjectSettings? {
        let settingsURL = rootURL.appendingPathComponent(".tex180/settings.json")
        guard FileManager.default.fileExists(atPath: settingsURL.path) else {
            return nil
        }
        guard let data = try? Data(contentsOf: settingsURL) else {
            return nil
        }
        return try? JSONDecoder().decode(ProjectSettings.self, from: data)
    }

    private func saveSettings(rootURL: URL, settings: ProjectSettings) -> Result<Void, Error> {
        do {
            let directoryURL = rootURL.appendingPathComponent(".tex180")
            try FileManager.default.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true,
                attributes: nil
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(settings)
            let settingsURL = directoryURL.appendingPathComponent("settings.json")
            try data.write(to: settingsURL, options: .atomic)
            return .success(())
        } catch {
            return .failure(error)
        }
    }

    private func removeSettings(rootURL: URL) -> Result<Void, Error> {
        let settingsURL = rootURL.appendingPathComponent(".tex180/settings.json")
        guard FileManager.default.fileExists(atPath: settingsURL.path) else {
            return .success(())
        }
        do {
            try FileManager.default.removeItem(at: settingsURL)
            return .success(())
        } catch {
            return .failure(error)
        }
    }

    private func withScopedAccess<T>(
        rootURL: URL,
        _ work: () throws -> T
    ) -> Result<T, Error> {
        let didStartAccess = rootURL.startAccessingSecurityScopedResource()
        defer {
            if didStartAccess {
                rootURL.stopAccessingSecurityScopedResource()
            }
        }
        do {
            return .success(try work())
        } catch {
            return .failure(error)
        }
    }
}
