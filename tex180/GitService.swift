//
//  GitService.swift
//  tex180
//
//  Created by Codex.
//

import Foundation

struct GitStatusEntry {
    let status: String
    let path: String
}

struct GitStatusSnapshot {
    let entries: [GitStatusEntry]
    let message: String?
}

final class GitService {
    private let queue = DispatchQueue(label: "tex180.git", qos: .utility)

    func status(rootURL: URL, completion: @escaping (GitStatusSnapshot) -> Void) {
        queue.async {
            let snapshot = self.runStatus(rootURL: rootURL)
            DispatchQueue.main.async {
                completion(snapshot)
            }
        }
    }

    private func runStatus(rootURL: URL) -> GitStatusSnapshot {
        let didStartAccess = rootURL.startAccessingSecurityScopedResource()
        defer {
            if didStartAccess {
                rootURL.stopAccessingSecurityScopedResource()
            }
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git", "-C", rootURL.path, "status", "--porcelain"]

        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = outputPipe

        do {
            try process.run()
        } catch {
            return GitStatusSnapshot(entries: [], message: "Gitの実行に失敗しました。")
        }

        process.waitUntilExit()
        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: outputData, encoding: .utf8) ?? ""

        guard process.terminationStatus == 0 else {
            return GitStatusSnapshot(entries: [], message: "Gitリポジトリではありません。")
        }

        let lines = output.split(whereSeparator: \.isNewline).map(String.init)
        let entries = lines.compactMap { line -> GitStatusEntry? in
            guard line.count >= 3 else { return nil }
            let status = String(line.prefix(2)).trimmingCharacters(in: .whitespaces)
            let pathStart = line.index(line.startIndex, offsetBy: 3)
            var path = String(line[pathStart...]).trimmingCharacters(in: .whitespaces)
            if let arrowRange = path.range(of: "->") {
                path = String(path[arrowRange.upperBound...]).trimmingCharacters(in: .whitespaces)
            }
            return GitStatusEntry(status: status, path: path)
        }

        return GitStatusSnapshot(entries: entries, message: entries.isEmpty ? "変更はありません。" : nil)
    }
}
