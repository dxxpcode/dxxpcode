import SwiftUI

// Screen 5 — server info + unpair. Danger action stays out of the way, same as
// desktop Settings' red rows.
struct SettingsView: View {
    @EnvironmentObject var app: AppModel
    @State private var health: DxxpAPI.Health?
    @State private var confirmUnpair = false

    var body: some View {
        Form {
            Section {
                row("Server", "\(app.pair?.host ?? "?"):\(app.pair?.port ?? 0)")
                if let health {
                    row("Name", health.name)
                    row("Version", health.version)
                    row("API", "v\(health.api)")
                }
            } header: { Text("DESKTOP").font(.dxGroupLabel).tracking(1.1).foregroundStyle(Color.dxFaint.opacity(0.75)) }

            Section {
                Button("Unpair iPhone", role: .destructive) { confirmUnpair = true }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.dxBg)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task { health = try? await app.api?.health() }
        .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { app.unpair() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes the saved server + token. Pair again by scanning the QR on the desktop.")
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).font(.callout)
            Spacer()
            Text(v).font(.dxMonoSmall).foregroundStyle(Color.dxFaint)
        }
    }
}
