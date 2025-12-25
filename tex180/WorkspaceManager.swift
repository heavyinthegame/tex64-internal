//
//  WorkspaceManager.swift
//  tex180
//
//  Created by Codex.
//

import AppKit
import Foundation

final class WorkspaceManager {
    private(set) var rootURL: URL?

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
            completion(url)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: handler)
        } else {
            handler(panel.runModal())
        }
    }

    func createNewProject(window: NSWindow?, completion: @escaping (Result<URL, Error>) -> Void) {
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
                let result = self?.initializeProject(at: url) ?? .failure(WorkspaceError.unknown)
                DispatchQueue.main.async {
                    switch result {
                    case .success:
                        self?.rootURL = url
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

    enum WorkspaceError: LocalizedError, Equatable {
        case invalidPath
        case invalidEncoding
        case alreadyExists
        case notEmpty
        case cancelled
        case unknown

        var errorDescription: String? {
            switch self {
            case .invalidPath:
                return "不正なパスです。"
            case .invalidEncoding:
                return "UTF-8以外の文字コードです。"
            case .alreadyExists:
                return "すでに存在します。"
            case .notEmpty:
                return "フォルダが空ではありません。"
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

    private func initializeProject(at rootURL: URL) -> Result<Void, Error> {
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
            let tex180URL = rootURL.appendingPathComponent(".tex180")
            try FileManager.default.createDirectory(at: tex180URL, withIntermediateDirectories: true, attributes: nil)
            let mainTex = [
                "\\documentclass{article}",
                "\\begin{document}",
                "Hello tex180.",
                "\\end{document}",
                "",
            ].joined(separator: "\n")
            let mainTexURL = rootURL.appendingPathComponent("main.tex")
            guard let mainData = mainTex.data(using: .utf8) else {
                throw WorkspaceError.invalidEncoding
            }
            try mainData.write(to: mainTexURL, options: .atomic)
            let settingsURL = tex180URL.appendingPathComponent("settings.json")
            let blocksURL = tex180URL.appendingPathComponent("blocks.json")
            guard let settingsData = "{}\n".data(using: .utf8),
                  let blocksData = "[]\n".data(using: .utf8) else {
                throw WorkspaceError.invalidEncoding
            }
            try settingsData.write(to: settingsURL, options: .atomic)
            try blocksData.write(to: blocksURL, options: .atomic)
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
