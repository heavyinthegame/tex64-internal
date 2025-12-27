//
//  BuildService.swift
//  tex180
//
//  Created by Codex.
//

import Foundation

enum BuildIssueSeverity: String {
    case error
    case warning
}

struct BuildIssue {
    let severity: BuildIssueSeverity
    let message: String
    let line: Int?
}

enum BuildResult {
    case success(summary: String, issues: [BuildIssue], pdfURL: URL)
    case failure(summary: String, issues: [BuildIssue])
    case busy
}

final class BuildService {
    private let queue = DispatchQueue(label: "tex180.build", qos: .userInitiated)
    private var isBuilding = false

    func build(rootURL: URL, mainFileName: String = "main.tex", completion: @escaping (BuildResult) -> Void) {
        queue.async {
            if self.isBuilding {
                DispatchQueue.main.async {
                    completion(.busy)
                }
                return
            }
            self.isBuilding = true
            let result = self.runBuild(rootURL: rootURL, mainFileName: mainFileName)
            self.isBuilding = false
            DispatchQueue.main.async {
                completion(result)
            }
        }
    }

    private func runBuild(rootURL: URL, mainFileName: String) -> BuildResult {
        print("[tex180] runBuild called: \(rootURL.path), \(mainFileName)")
        let didStartAccess = rootURL.startAccessingSecurityScopedResource()
        print("[tex180] runBuild: security access started: \(didStartAccess)")
        defer {
            if didStartAccess {
                rootURL.stopAccessingSecurityScopedResource()
            }
        }
        let mainFileURL = rootURL.appendingPathComponent(mainFileName)
        guard FileManager.default.fileExists(atPath: mainFileURL.path) else {
            print("[tex180] runBuild: main file not found: \(mainFileURL.path)")
            let issue = BuildIssue(severity: .error, message: "\(mainFileName) が見つかりません。", line: nil)
            return .failure(summary: issue.message, issues: [issue])
        }
        let pdfURL = mainFileURL
            .deletingPathExtension()
            .appendingPathExtension("pdf")

        let output: String
        let status: Int32

        do {
            let result = try runLatexmk(rootURL: rootURL, mainFileName: mainFileName)
            output = result.output
            status = result.status
            print("[tex180] runBuild: latexmk status: \(status)")
            print("[tex180] runBuild: latexmk output:\n\(output)")
        } catch {
            print("[tex180] runBuild: latexmk failed to start: \(error)")
            let issue = BuildIssue(severity: .error, message: "ビルドの起動に失敗しました。", line: nil)
            return .failure(summary: issue.message, issues: [issue])
        }

        let issues = parseIssues(from: output)
        if status == 0 {
            return .success(summary: "ビルド成功", issues: issues, pdfURL: pdfURL)
        }
        let summary = failureSummary(output: output, issues: issues, mainFileName: mainFileName)
        let fallbackIssue = BuildIssue(severity: .error, message: summary, line: nil)
        let finalIssues = issues.isEmpty ? [fallbackIssue] : issues
        return .failure(summary: summary, issues: finalIssues)
    }

    private struct ProcessOutput {
        let output: String
        let status: Int32
    }

    private func runLatexmk(rootURL: URL, mainFileName: String) throws -> ProcessOutput {
        // Find latexmk in known locations
        let searchPaths = [
            "/Library/TeX/texbin/latexmk",
            "/usr/local/bin/latexmk",
            "/opt/homebrew/bin/latexmk",
            "/usr/bin/latexmk",
        ]
        guard let latexmkPath = searchPaths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            print("[tex180] latexmk not found in any of: \(searchPaths)")
            throw NSError(domain: "BuildService", code: 1, userInfo: [NSLocalizedDescriptionKey: "latexmk not found"])
        }
        print("[tex180] Using latexmk at: \(latexmkPath)")
        
        let process = Process()
        process.executableURL = URL(fileURLWithPath: latexmkPath)
        process.arguments = [
            "-lualatex",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            mainFileName,
        ]
        process.currentDirectoryURL = rootURL
        process.standardInput = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        let existingPath = environment["PATH"] ?? ""
        let pathDirs = [
            "/Library/TeX/texbin",
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin",
            "/bin",
            existingPath,
        ]
        environment["PATH"] = pathDirs.joined(separator: ":")
        process.environment = environment

        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = outputPipe

        var outputData = Data()
        outputPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty {
                outputData.append(chunk)
            }
        }

        try process.run()
        process.waitUntilExit()
        outputPipe.fileHandleForReading.readabilityHandler = nil

        let output = String(data: outputData, encoding: .utf8) ?? ""
        return ProcessOutput(output: output, status: process.terminationStatus)
    }

    private func parseIssues(from output: String) -> [BuildIssue] {
        let lines = output.split(whereSeparator: \.isNewline)
            .map { String($0) }
        var issues: [BuildIssue] = []
        let maxIssues = 20
        for line in lines {
            if issues.count >= maxIssues {
                break
            }
            if line.hasPrefix("!") || line.contains("LaTeX Error") {
                let message = line.trimmingCharacters(in: .whitespaces)
                let lineNumber = extractLineNumber(from: line)
                issues.append(BuildIssue(severity: .error, message: message, line: lineNumber))
            } else if line.contains("Warning") {
                let message = line.trimmingCharacters(in: .whitespaces)
                let lineNumber = extractLineNumber(from: line)
                issues.append(BuildIssue(severity: .warning, message: message, line: lineNumber))
            }
        }
        return issues
    }

    private func extractLineNumber(from line: String) -> Int? {
        // Match "l.10" or ":10:" patterns
        let pattern = #"(?:l\.|:)(\d+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return nil
        }
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = regex.firstMatch(in: line, range: range) else {
            return nil
        }
        guard let numberRange = Range(match.range(at: 1), in: line) else {
            return nil
        }
        return Int(line[numberRange])
    }

    private func failureSummary(output: String, issues: [BuildIssue], mainFileName: String) -> String {
        if output.localizedCaseInsensitiveContains("latexmk")
            && output.localizedCaseInsensitiveContains("not found") {
            return "latexmk が見つかりません。TeX環境を確認してください。"
        }
        if output.localizedCaseInsensitiveContains(mainFileName)
            && output.localizedCaseInsensitiveContains("No such file") {
            return "\(mainFileName) が見つかりません。"
        }
        if let first = issues.first {
            return first.message
        }
        return "ビルドに失敗しました。Issuesを確認してください。"
    }
}
