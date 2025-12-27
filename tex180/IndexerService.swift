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

struct SectionSymbol {
    let title: String
    let path: String
    let line: Int
    let level: Int
}

struct IndexSnapshot {
    let labels: [IndexSymbol]
    let references: [IndexSymbol]
    let citations: [IndexSymbol]
    let sections: [SectionSymbol]
    let figures: [IndexSymbol]
    let tables: [IndexSymbol]
    let todos: [IndexSymbol]
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
        var sectionSymbols: [SectionSymbol] = []
        var figureSymbols: [IndexSymbol] = []
        var tableSymbols: [IndexSymbol] = []
        var todoSymbols: [IndexSymbol] = []

        let labelRegex = try? NSRegularExpression(pattern: #"\\label\{([^}]+)\}"#)
        let refRegex = try? NSRegularExpression(pattern: #"\\ref\{([^}]+)\}"#)
        let citeRegex = try? NSRegularExpression(pattern: #"\\cite\{([^}]+)\}"#)
        let bibRegex = try? NSRegularExpression(pattern: #"@\w+\s*\{\s*([^,\s]+)"#)
        let sectionRegex = try? NSRegularExpression(
            pattern: #"\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]+)\}"#
        )
        let beginEnvRegex = try? NSRegularExpression(pattern: #"\\begin\{(figure\*?|table\*?)\}"#)
        let endEnvRegex = try? NSRegularExpression(pattern: #"\\end\{(figure\*?|table\*?)\}"#)
        let captionRegex = try? NSRegularExpression(pattern: #"\\caption\*?\{([^}]+)\}"#)
        let todoRegex = try? NSRegularExpression(pattern: #"\\todo\{([^}]+)\}"#)
        let todoTextRegex = try? NSRegularExpression(pattern: #"(?i)^\s*(?:%+\s*)?TODO[:：]?\s*(.+)"#)

        guard let enumerator = FileManager.default.enumerator(
            at: rootURL,
            includingPropertiesForKeys: [.isDirectoryKey, .nameKey],
            options: [.skipsHiddenFiles]
        ) else {
            return IndexSnapshot(
                labels: [],
                references: [],
                citations: [],
                sections: [],
                figures: [],
                tables: [],
                todos: []
            )
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

            let lines = content
                .split(omittingEmptySubsequences: false, whereSeparator: { $0.isNewline })
                .map(String.init)
            if ext == "tex" {
                var envStack: [String] = []
                for (index, line) in lines.enumerated() {
                    let lineNumber = index + 1
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    if trimmed.hasPrefix("%") {
                        continue
                    }
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
                    if let sectionRegex {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        for match in sectionRegex.matches(in: line, range: range) {
                            guard let commandRange = Range(match.range(at: 1), in: line),
                                  let titleRange = Range(match.range(at: 2), in: line) else { continue }
                            let command = String(line[commandRange])
                            let title = String(line[titleRange])
                            let level = sectionLevel(command: command)
                            sectionSymbols.append(
                                SectionSymbol(title: title, path: relativePath, line: lineNumber, level: level)
                            )
                        }
                    }
                    if let beginEnvRegex {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        if let match = beginEnvRegex.firstMatch(in: line, range: range),
                           let envRange = Range(match.range(at: 1), in: line) {
                            let env = String(line[envRange]).replacingOccurrences(of: "*", with: "")
                            envStack.append(env)
                        }
                    }
                    if let endEnvRegex {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        if let match = endEnvRegex.firstMatch(in: line, range: range),
                           let envRange = Range(match.range(at: 1), in: line) {
                            let env = String(line[envRange]).replacingOccurrences(of: "*", with: "")
                            if let index = envStack.lastIndex(of: env) {
                                envStack.remove(at: index)
                            }
                        }
                    }
                    if let captionRegex {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        for match in captionRegex.matches(in: line, range: range) {
                            guard let titleRange = Range(match.range(at: 1), in: line) else { continue }
                            let title = String(line[titleRange])
                            if let currentEnv = envStack.last {
                                if currentEnv == "figure" {
                                    figureSymbols.append(IndexSymbol(key: title, path: relativePath, line: lineNumber))
                                } else if currentEnv == "table" {
                                    tableSymbols.append(IndexSymbol(key: title, path: relativePath, line: lineNumber))
                                }
                            }
                        }
                    }
                    if let todoRegex {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        for match in todoRegex.matches(in: line, range: range) {
                            guard let textRange = Range(match.range(at: 1), in: line) else { continue }
                            let text = String(line[textRange])
                            todoSymbols.append(IndexSymbol(key: text, path: relativePath, line: lineNumber))
                        }
                    }
                    if let todoTextRegex {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        if let match = todoTextRegex.firstMatch(in: line, range: range),
                           let textRange = Range(match.range(at: 1), in: line) {
                            let text = String(line[textRange])
                            todoSymbols.append(IndexSymbol(key: text, path: relativePath, line: lineNumber))
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
        let uniqueFigures = dedupe(symbols: figureSymbols)
        let uniqueTables = dedupe(symbols: tableSymbols)
        let uniqueTodos = dedupe(symbols: todoSymbols)
        let uniqueSections = dedupe(sections: sectionSymbols)

        return IndexSnapshot(
            labels: uniqueLabels,
            references: uniqueReferences,
            citations: uniqueCitations,
            sections: uniqueSections,
            figures: uniqueFigures,
            tables: uniqueTables,
            todos: uniqueTodos
        )
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

    private func dedupe(sections: [SectionSymbol]) -> [SectionSymbol] {
        var seen = Set<String>()
        var result: [SectionSymbol] = []
        for section in sections {
            let token = "\(section.title)|\(section.path)|\(section.line)|\(section.level)"
            guard !seen.contains(token) else { continue }
            seen.insert(token)
            result.append(section)
        }
        return result
    }

    private func sectionLevel(command: String) -> Int {
        switch command {
        case "part":
            return 1
        case "chapter":
            return 2
        case "section":
            return 3
        case "subsection":
            return 4
        case "subsubsection":
            return 5
        case "paragraph":
            return 6
        case "subparagraph":
            return 7
        default:
            return 3
        }
    }
}
