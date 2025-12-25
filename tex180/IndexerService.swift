//
//  IndexerService.swift
//  tex180
//
//  Created by Codex.
//

import Foundation

struct IndexSymbol {
    let key: String
    let path: String
    let line: Int
}

struct IndexSnapshot {
    let labels: [IndexSymbol]
    let references: [IndexSymbol]
    let citations: [IndexSymbol]
}

final class IndexerService {
    private let queue = DispatchQueue(label: "tex180.indexer", qos: .utility)
    private var isIndexing = false
    private var pendingRootURL: URL?

    func requestIndex(rootURL: URL, completion: @escaping (IndexSnapshot) -> Void) {
        queue.async {
            self.pendingRootURL = rootURL
            guard !self.isIndexing else { return }
            self.isIndexing = true

            while let nextURL = self.pendingRootURL {
                self.pendingRootURL = nil
                let snapshot = self.buildIndex(rootURL: nextURL)
                DispatchQueue.main.async {
                    completion(snapshot)
                }
            }

            self.isIndexing = false
        }
    }

    private func buildIndex(rootURL: URL) -> IndexSnapshot {
        let didStartAccess = rootURL.startAccessingSecurityScopedResource()
        defer {
            if didStartAccess {
                rootURL.stopAccessingSecurityScopedResource()
            }
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

        var labelSymbols: [IndexSymbol] = []
        var referenceSymbols: [IndexSymbol] = []
        var citationSymbols: [IndexSymbol] = []

        let labelRegex = try? NSRegularExpression(pattern: #"\\label\{([^}]+)\}"#)
        let refRegex = try? NSRegularExpression(pattern: #"\\ref\{([^}]+)\}"#)
        let citeRegex = try? NSRegularExpression(pattern: #"\\cite\{([^}]+)\}"#)
        let bibRegex = try? NSRegularExpression(pattern: #"@\w+\s*\{\s*([^,\s]+)"#)

        guard let enumerator = FileManager.default.enumerator(
            at: rootURL,
            includingPropertiesForKeys: [.isDirectoryKey, .nameKey],
            options: [.skipsHiddenFiles]
        ) else {
            return IndexSnapshot(labels: [], references: [], citations: [])
        }

        let rootPath = rootURL.standardizedFileURL.path

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

            let ext = fileURL.pathExtension.lowercased()
            guard ext == "tex" || ext == "bib" else { continue }

            let relativePath: String
            let filePath = fileURL.standardizedFileURL.path
            if filePath.hasPrefix(rootPath + "/") {
                relativePath = String(filePath.dropFirst(rootPath.count + 1))
            } else {
                continue
            }

            guard let content = try? String(contentsOf: fileURL, encoding: .utf8) else {
                continue
            }

            let lines = content.split(whereSeparator: \.isNewline).map(String.init)
            if ext == "tex" {
                for (index, line) in lines.enumerated() {
                    let lineNumber = index + 1
                    if let labelRegex {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        for match in labelRegex.matches(in: line, range: range) {
                            guard let keyRange = Range(match.range(at: 1), in: line) else { continue }
                            let key = String(line[keyRange])
                            labelSymbols.append(IndexSymbol(key: key, path: relativePath, line: lineNumber))
                        }
                    }
                    if let citeRegex {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        for match in citeRegex.matches(in: line, range: range) {
                            guard let keyRange = Range(match.range(at: 1), in: line) else { continue }
                            let rawKeys = String(line[keyRange])
                            let keys = rawKeys.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                            for key in keys where !key.isEmpty {
                                citationSymbols.append(IndexSymbol(key: key, path: relativePath, line: lineNumber))
                            }
                        }
                    }
                    if let refRegex {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        for match in refRegex.matches(in: line, range: range) {
                            guard let keyRange = Range(match.range(at: 1), in: line) else { continue }
                            let key = String(line[keyRange])
                            referenceSymbols.append(IndexSymbol(key: key, path: relativePath, line: lineNumber))
                        }
                    }
                }
            } else if ext == "bib" {
                for (index, line) in lines.enumerated() {
                    let lineNumber = index + 1
                    guard let bibRegex else { continue }
                    let range = NSRange(line.startIndex..<line.endIndex, in: line)
                    for match in bibRegex.matches(in: line, range: range) {
                        guard let keyRange = Range(match.range(at: 1), in: line) else { continue }
                        let key = String(line[keyRange])
                        citationSymbols.append(IndexSymbol(key: key, path: relativePath, line: lineNumber))
                    }
                }
            }
        }

        let uniqueLabels = dedupe(symbols: labelSymbols)
        let uniqueReferences = dedupe(symbols: referenceSymbols)
        let uniqueCitations = dedupe(symbols: citationSymbols)

        return IndexSnapshot(labels: uniqueLabels, references: uniqueReferences, citations: uniqueCitations)
    }

    private func dedupe(symbols: [IndexSymbol]) -> [IndexSymbol] {
        var seen = Set<String>()
        var result: [IndexSymbol] = []
        for symbol in symbols {
            let token = "\(symbol.key)|\(symbol.path)|\(symbol.line)"
            guard !seen.contains(token) else { continue }
            seen.insert(token)
            result.append(symbol)
        }
        return result
    }
}
