import SwiftUI
import UIKit
import VisionKit

// Screen 1 — pair with the desktop: scan the QR shown by Settings → iPhone
// companion, or paste the dxxpcode://pair URL manually.
struct PairView: View {
    @EnvironmentObject var app: AppModel
    @State private var scanning = false
    @State private var manual = ""
    @State private var error: String?

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            VStack(spacing: 10) {
                XXMark()
                    .fill(Color.dxText)
                    .frame(width: 60, height: 60)
                Text("DxxpCode")
                    .font(.system(size: 26, weight: .semibold))
                Text("Companion for your local agent")
                    .font(.callout)
                    .foregroundStyle(Color.dxFaint)
            }
            VStack(spacing: 12) {
                Button {
                    DXHaptics.tap()
                    scanning = true
                } label: {
                    Label("Scan pairing QR", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(DXPrimaryButton())

                HStack(spacing: 8) {
                    TextField("or paste dxxpcode://pair?…", text: $manual)
                        .font(.dxMonoSmall)
                        .textFieldStyle(.plain)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .submitLabel(.go)
                        .onSubmit { tryPair(manual) }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                    if let clip = UIPasteboard.general.string,
                       clip.hasPrefix("dxxpcode://pair"), manual.isEmpty {
                        Button("Paste") { manual = clip }
                            .font(.callout.weight(.medium))
                            .padding(.trailing, 4)
                    }
                    if !manual.isEmpty {
                        Button("Pair") { tryPair(manual) }
                            .font(.callout.weight(.medium))
                            .padding(.trailing, 8)
                    }
                }
                .background(Color.dxSurface2)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.dxBorder, lineWidth: 0.5))
            }
            .padding(.horizontal, 28)

            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Color.dxRed)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                    .dxCard()
                    .padding(.horizontal, 28)
            }

            Spacer()
            Text("Desktop: Settings → iPhone companion → on.\nThe QR encodes the server URL + token on your LAN.")
                .font(.caption2)
                .foregroundStyle(Color.dxFaint.opacity(0.8))
                .multilineTextAlignment(.center)
                .padding(.bottom, 24)
        }
        .background(Color.dxBg.ignoresSafeArea())
        .sheet(isPresented: $scanning) {
            ScannerView { url in
                scanning = false
                tryPair(url.absoluteString)
            }
        }
    }

    private func tryPair(_ raw: String) {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let p = PairInfo(url: url) else {
            error = "Not a pairing URL — expected dxxpcode://pair?host=…&token=…"
            return
        }
        error = nil
        app.pair(p)
    }
}

// VisionKit's DataScannerViewController: native QR scanning, no AVFoundation
// plumbing. One `dxxpcode://pair` hit completes the pair.
struct ScannerView: UIViewControllerRepresentable {
    var onScan: (URL) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .accurate,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (URL) -> Void
        init(onScan: @escaping (URL) -> Void) { self.onScan = onScan }
        func dataScanner(_ scanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            handle(item)
        }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            if let first = addedItems.first { handle(first) }
        }
        private func handle(_ item: RecognizedItem) {
            guard case .barcode(let code) = item,
                  let s = code.payloadStringValue,
                  let url = URL(string: s) else { return }
            onScan(url)
        }
    }
}
