//
//  ProjectLauncherView.swift
//  tex180
//
//  Created by Codex.
//

import AppKit
import SwiftUI

struct ProjectLauncherView: View {
    @ObservedObject var appModel: AppModel
    @State private var statusMessage: String?
    @State private var isBusy = false

    var body: some View {
        ZStack {
            LauncherBackground()

            VStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("tex180")
                            .font(.custom("Menlo", size: 30))
                            .foregroundStyle(.white)
                            .kerning(1.6)
                        Text("LaTeX編集の起点")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.white.opacity(0.72))
                    }

                    Text("最初にプロジェクトを選択してください。")
                        .font(.custom("Hiragino Sans", size: 12))
                        .foregroundStyle(Color.white.opacity(0.6))

                }

                Divider()
                    .overlay(Color.white.opacity(0.08))

                VStack(spacing: 12) {
                    Button {
                        createNewProject()
                    } label: {
                        LauncherButtonLabel(
                            title: "新規プロジェクトを作成",
                            detail: "main.tex と .tex180 を作成します",
                            systemImage: "plus.square.fill"
                        )
                    }
                    .buttonStyle(LaunchButtonStyle(isPrimary: true))
                    .disabled(isBusy)

                    Button {
                        openExistingProject()
                    } label: {
                        LauncherButtonLabel(
                            title: "既存のフォルダを開く",
                            detail: "既存のLaTeXフォルダを開きます",
                            systemImage: "folder.fill"
                        )
                    }
                    .buttonStyle(LaunchButtonStyle(isPrimary: false))
                    .disabled(isBusy)
                }

                if isBusy {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("準備中...")
                    }
                    .font(.footnote)
                    .foregroundStyle(Color.white.opacity(0.7))
                } else if let statusMessage {
                    Text(statusMessage)
                        .font(.footnote)
                        .foregroundStyle(Color.white.opacity(0.7))
                }
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(36)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color(red: 0.12, green: 0.14, blue: 0.18).opacity(0.85))
                    .background(.ultraThinMaterial)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.22),
                                Color.white.opacity(0.06),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            )
            .shadow(color: Color.black.opacity(0.35), radius: 18, x: 0, y: 12)
            .padding(32)
        }
    }

    private func openExistingProject() {
        guard !isBusy else { return }
        isBusy = true
        statusMessage = nil
        appModel.openExistingWorkspace(window: NSApp.keyWindow) { message in
            isBusy = false
            if let message {
                statusMessage = message
            }
        }
    }

    private func createNewProject() {
        guard !isBusy else { return }
        isBusy = true
        statusMessage = nil
        appModel.createNewProject(window: NSApp.keyWindow) { message in
            isBusy = false
            if let message {
                statusMessage = message
            }
        }
    }
}

private struct LauncherButtonLabel: View {
    let title: String
    let detail: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .semibold))
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.custom("Hiragino Sans", size: 14))
                Text(detail)
                    .font(.custom("Hiragino Sans", size: 11))
                    .foregroundStyle(Color.white.opacity(0.7))
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.white.opacity(0.55))
        }
        .padding(.vertical, 8)
    }
}

private struct LaunchButtonStyle: ButtonStyle {
    let isPrimary: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(backgroundFill(isPressed: configuration.isPressed))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.white.opacity(isPrimary ? 0.15 : 0.08), lineWidth: 1)
            )
            .foregroundStyle(.white)
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .shadow(
                color: Color.black.opacity(configuration.isPressed ? 0.2 : 0.3),
                radius: configuration.isPressed ? 3 : 10,
                x: 0,
                y: configuration.isPressed ? 2 : 6
            )
    }

    private func backgroundFill(isPressed: Bool) -> AnyShapeStyle {
        if isPrimary {
            return AnyShapeStyle(
                LinearGradient(
                    colors: [
                        Color(red: 0.26, green: 0.62, blue: 0.98),
                        Color(red: 0.18, green: 0.48, blue: 0.86),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
        }
        return AnyShapeStyle(Color.white.opacity(isPressed ? 0.12 : 0.08))
    }
}

private struct LauncherBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.12, green: 0.16, blue: 0.21),
                    Color(red: 0.07, green: 0.09, blue: 0.12),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            RadialGradient(
                colors: [
                    Color(red: 0.36, green: 0.62, blue: 0.92, opacity: 0.35),
                    Color.clear,
                ],
                center: .topLeading,
                startRadius: 40,
                endRadius: 320
            )
            .offset(x: -120, y: -140)

            RadialGradient(
                colors: [
                    Color(red: 0.18, green: 0.5, blue: 0.78, opacity: 0.2),
                    Color.clear,
                ],
                center: .bottomTrailing,
                startRadius: 60,
                endRadius: 360
            )
            .offset(x: 140, y: 180)

            GridOverlay(spacing: 72, lineColor: Color.white.opacity(0.04))
                .mask(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.9),
                            Color.white.opacity(0.2),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
        }
        .ignoresSafeArea()
    }
}

private struct GridOverlay: View {
    let spacing: CGFloat
    let lineColor: Color

    var body: some View {
        GeometryReader { proxy in
            Path { path in
                let size = proxy.size
                let columns = Int(size.width / spacing)
                let rows = Int(size.height / spacing)

                for column in 0...columns {
                    let x = CGFloat(column) * spacing
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x, y: size.height))
                }

                for row in 0...rows {
                    let y = CGFloat(row) * spacing
                    path.move(to: CGPoint(x: 0, y: y))
                    path.addLine(to: CGPoint(x: size.width, y: y))
                }
            }
            .stroke(lineColor, lineWidth: 0.5)
        }
        .allowsHitTesting(false)
    }
}

#Preview {
    ProjectLauncherView(appModel: AppModel())
}
