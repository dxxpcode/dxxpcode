import SwiftUI

// Screen 5 — live server status card, appearance override, unpair (the only
// destructive row, at the bottom — same as desktop Settings' red rows).
struct SettingsView: View {
    @EnvironmentObject var app: AppModel
    @AppStorage("appearance") private var appearance = Appearance.system.rawValue
    @State private var health: DxxpAPI.Health?
    @State private var reachable = false
    @State private var confirmUnpair = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 0) {
                    DXGroupLabel("Desktop")
                    VStack(spacing: 0) {
                        HStack(spacing: 8) {
                            Circle()
                                .fill(reachable ? Color(UIColor.dx(light: 0x16a34a, dark: 0x4ade80)) : Color.dxRed)
                                .frame(width: 7, height: 7)
                            Text(reachable ? "connected" : "unreachable")
                                .font(.callout.weight(.medium))
                            Spacer()
                            if let health {
                                Text("\(health.name) v\(health.version)")
                                    .font(.dxMonoSmall)
                                    .foregroundStyle(Color.dxFaint)
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        Divider().overlay(Color.dxBorder.opacity(0.5)).padding(.leading, 12)
                        HStack {
                            Text("Server").font(.callout)
                            Spacer()
                            Text("\(app.pair?.host ?? "?"):\(app.pair?.port ?? 0)")
                                .font(.dxMonoSmall)
                                .foregroundStyle(Color.dxFaint)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                    }
                    .dxCard()
                    .padding(.horizontal, 16)
                }

                VStack(alignment: .leading, spacing: 0) {
                    DXGroupLabel("Appearance")
                    HStack {
                        ForEach(Appearance.allCases) { a in
                            Button {
                                DXHaptics.tap()
                                appearance = a.rawValue
                            } label: {
                                Text(a.rawValue.capitalized)
                                    .font(.callout.weight(appearance == a.rawValue ? .semibold : .regular))
                                    .foregroundStyle(appearance == a.rawValue ? Color.dxText : Color.dxFaint)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 8)
                                    .background(appearance == a.rawValue ? Color.dxSurface2 : Color.clear)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(4)
                    .dxCard()
                    .padding(.horizontal, 16)
                }

                Spacer(minLength: 24)

                VStack(alignment: .leading, spacing: 0) {
                    Button(role: .destructive) { confirmUnpair = true } label: {
                        Text("Unpair iPhone")
                            .font(.callout)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.dxRed)
                    .dxCard()
                    .padding(.horizontal, 16)
                }
            }
            .padding(.top, 8)
        }
        .background(Color.dxBg)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            health = try? await app.api?.health()
            reachable = health != nil
        }
        .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { app.unpair() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes the saved server + token. Pair again by scanning the QR on the desktop.")
        }
    }
}
