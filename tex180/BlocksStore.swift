//
//  BlocksStore.swift
//  tex180
//
//  Created by Codex.
//

import Foundation

struct BlockContent: Codable {
    let formula: String?
    let rows: Int?
    let cols: Int?
}

struct BlockMeta: Codable {
    let id: String
    let type: String
    let file: String
    let line: Int
    let column: Int
    let snippet: String
    let content: BlockContent
    let deps: [String]
    let updatedAt: String
}

final class BlocksStore {
    private let queue = DispatchQueue(label: "tex180.blocks", qos: .userInitiated)

    func load(rootURL: URL, completion: @escaping (Result<[BlockMeta], Error>) -> Void) {
        queue.async {
            let result = self.loadSync(rootURL: rootURL)
            DispatchQueue.main.async {
                completion(result)
            }
        }
    }

    func save(rootURL: URL, blocks: [BlockMeta], completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            let result = self.saveSync(rootURL: rootURL, blocks: blocks)
            DispatchQueue.main.async {
                completion(result)
            }
        }
    }

    private func loadSync(rootURL: URL) -> Result<[BlockMeta], Error> {
        let didStartAccess = rootURL.startAccessingSecurityScopedResource()
        defer {
            if didStartAccess {
                rootURL.stopAccessingSecurityScopedResource()
            }
        }
        let fileURL = blocksFileURL(rootURL: rootURL)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return .success([])
        }
        do {
            let data = try Data(contentsOf: fileURL)
            let blocks = try JSONDecoder().decode([BlockMeta].self, from: data)
            return .success(blocks)
        } catch {
            return .failure(error)
        }
    }

    private func saveSync(rootURL: URL, blocks: [BlockMeta]) -> Result<Void, Error> {
        let didStartAccess = rootURL.startAccessingSecurityScopedResource()
        defer {
            if didStartAccess {
                rootURL.stopAccessingSecurityScopedResource()
            }
        }
        do {
            let directoryURL = rootURL.appendingPathComponent(".tex180")
            try FileManager.default.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true,
                attributes: nil
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(blocks)
            let fileURL = directoryURL.appendingPathComponent("blocks.json")
            try data.write(to: fileURL, options: .atomic)
            return .success(())
        } catch {
            return .failure(error)
        }
    }

    private func blocksFileURL(rootURL: URL) -> URL {
        rootURL.appendingPathComponent(".tex180/blocks.json")
    }
}
