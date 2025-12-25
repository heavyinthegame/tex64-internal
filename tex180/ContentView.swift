//
//  ContentView.swift
//  tex180
//
//  Created by 幸川 on 2025/12/25.
//

import SwiftUI

struct ContentView: View {
    @StateObject private var appModel = AppModel()

    var body: some View {
        if appModel.workspaceURL == nil {
            ProjectLauncherView(appModel: appModel)
        } else {
            EditorContainerView(appModel: appModel)
        }
    }
}

#Preview {
    ContentView()
}
