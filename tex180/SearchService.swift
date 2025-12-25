//
//  SearchService.swift
//  tex180
//
//  Created by Codex.
//

import Foundation

struct SearchResult {
    let path: String
    let line: Int
    let preview: String
}

final class SearchService {
    private let queue = DispatchQueue(label: "tex180.search", qos: .userInitiated)

    func search(rootURL: URL, query: String, completion: @escaping ([SearchResult]) -> Void) {
        queue.async {
            let results = self.runSearch(rootURL: rootURL, query: query)
            DispatchQueue.main.async {
                completion(results)
            }
        }
    }

    private func runSearch(rootURL: URL, query: String) -> [SearchResult] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

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

        let lowerQuery = trimmed.lowercased()
        let maxResults = 200
        var results: [SearchResult] = []

        guard let enumerator = FileManager.default.enumerator(
            at: rootURL,
            includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .nameKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        let rootPath = rootURL.standardizedFileURL.path

        for case let fileURL as URL in enumerator {
            if results.count >= maxResults {
                break
            }
            let values: URLResourceValues
            do {
                values = try fileURL.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .nameKey])
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

            guard let content = try? String(contentsOf: fileURL, encoding: .utf8) else {
                continue
            }
            let lines = content.split(whereSeparator: \.isNewline).map(String.init)
            for (index, line) in lines.enumerated() {
                if results.count >= maxResults {
                    break
                }
                if line.lowercased().contains(lowerQuery) {
                    let preview = line.trimmingCharacters(in: .whitespacesAndNewlines)
                    results.append(SearchResult(path: relativePath, line: index + 1, preview: preview))
                }
            }
        }

        return results
    }
}
