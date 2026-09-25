import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var inspectorVisible = true

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SidebarView()
        } detail: {
            detailContent
        }
        .inspector(isPresented: $inspectorVisible) {
            if let session = activeSession {
                InspectorView(session: session)
                    .inspectorColumnWidth(min: 240, ideal: 300, max: 420)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                EffortPicker()
                AutoApproveToggle()
            }
            ToolbarItem {
                Button {
                    inspectorVisible.toggle()
                } label: {
                    Label("Inspector", systemImage: "sidebar.trailing")
                }
                .keyboardShortcut("i", modifiers: [.command, .option])
            }
        }
        .focusedValue(\.session, activeSession)
        .navigationTitle(model.selectedProject?.name ?? "DxxpCode")
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            let appModel = model
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    if let url {
                        Task { await appModel.openProject(at: url) }
                    }
                }
            }
            return true
        }
    }

    @ViewBuilder
    private var detailContent: some View {
        if model.projects.isEmpty {
            EmptyStateView()
        } else if let project = model.selectedProject {
            Group {
                if let session = project.current {
                    SessionView(session: session)
                } else {
                    ContentUnavailableView("No Session Selected",
                                           systemImage: "bubble.left.and.bubble.right",
                                           description: Text("Pick a session in the sidebar or press ⌘N."))
                }
            }
            .task(id: SelectionKey(projectId: project.id, sessionId: model.selectedSessionId)) {
                project.ensureSession(model.selectedSessionId)
            }
        }
    }

    private var activeSession: SessionModel? {
        model.selectedProject?.current
    }
}

private struct SelectionKey: Equatable {
    let projectId: String
    let sessionId: String?
}
