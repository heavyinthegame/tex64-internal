//
//  AppModel.swift
//  tex180
//
//  Created by Codex.
//

import AppKit
import Combine
import SwiftUI

final class AppModel: ObservableObject {
    @Published private(set) var workspaceURL: URL?
    let workspaceManager = WorkspaceManager()
    let buildService = BuildService()
    let indexerService = IndexerService()
    let blocksStore = BlocksStore()
    let searchService = SearchService()
    let gitService = GitService()
    let pdfWindowController = PDFWindowController()

    func openExistingWorkspace(window: NSWindow?, completion: @escaping (String?) -> Void) {
        workspaceManager.selectWorkspace(window: window) { [weak self] url in
            guard let url else {
                completion(nil)
                return
            }
            self?.workspaceURL = url
            completion(nil)
        }
    }

    func createNewProject(
        window: NSWindow?,
        template: WorkspaceManager.ProjectTemplate,
        completion: @escaping (String?) -> Void
    ) {
        workspaceManager.createNewProject(window: window, template: template) { [weak self] result in
            switch result {
            case .success(let url):
                self?.workspaceURL = url
                completion(nil)
            case .failure(let error):
                if let workspaceError = error as? WorkspaceManager.WorkspaceError,
                   workspaceError == .cancelled {
                    completion(nil)
                } else {
                    completion(error.localizedDescription)
                }
            }
        }
    }
}
