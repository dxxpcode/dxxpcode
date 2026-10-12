import SwiftUI

// Screen 3 — live transcript for one task over SSE: items (text/tool/diff/
// plan), approval cards with approve/deny/always + editable plan, steer
// composer. Auto-scroll pins to the bottom only while the user is already
// there; a jump pill appears when new events land off-screen.
struct TaskDetailView: View {
    let taskId: String
    @EnvironmentObject var app: AppModel
    @State private var events: [DxxpAPI.SSEvent] = []
    @State private var lastEventId: Int?
    @State private var status = "connecting"
    @State private var steer = ""
    @State private var sendError: String?
    @State private var atBottom = true
    @State private var unseen = 0

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .bottom) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(events.enumerated()), id: \.offset) { _, ev in
                                EventView(event: ev.json, taskId: taskId)
                            }
                            Color.clear
                                .frame(height: 1)
                                .id("bottom")
                                .onAppear { atBottom = true; unseen = 0 }
                                .onDisappear { atBottom = false }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                    }
                    .onChange(of: events.count) {
                        if atBottom {
                            withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom") }
                        } else {
                            unseen += 1
                        }
                    }
                    .onTapGesture {
                        if unseen > 0 { proxy.scrollTo("bottom") }
                    }
                }

                if unseen > 0 {
                    Button {
                        DXHaptics.tap()
                        unseen = 0
                    } label: {
                        Label("\(unseen) new", systemImage: "arrow.down")
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Color.dxText)
                            .foregroundStyle(Color.dxBg)
                            .clipShape(Capsule())
                    }
                    .padding(.bottom, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }

            Divider().overlay(Color.dxBorder)

            HStack(spacing: 8) {
                TextField("Steer…", text: $steer, axis: .vertical)
                    .font(.callout)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color.dxSurface2)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.dxBorder, lineWidth: 0.5))
                Button { sendSteer() } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(steer.trimmingCharacters(in: .whitespaces).isEmpty ? Color.dxFaint : Color.dxText)
                }
                .disabled(steer.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.dxBg)
        }
        .background(Color.dxBg)
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Text(status)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(status == "approval" ? Color(UIColor.dx(light: 0xd97706, dark: 0xfbbf24)) : Color.dxFaint)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.dxSurface2)
                    .clipShape(Capsule())
            }
        }
        .task { await stream() }
    }

    private func stream() async {
        guard let api = app.api else { return }
        do {
            for try await ev in api.events(task: taskId, lastEventId: lastEventId) {
                events.append(ev)
                lastEventId = ev.id
                if let st = ev.json["status"]?.string { status = st }
                if ev.json["type"]?.string == "done" {
                    status = ev.json["result"]?.obj?["status"] as? String ?? "done"
                }
                if ev.json["type"]?.string == "approval" { status = "approval" }
            }
            if status == "connecting" || status == "running" { status = "idle" }
        } catch {
            sendError = error.localizedDescription
            status = "offline"
        }
    }

    private func sendSteer() {
        let text = steer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let api = app.api else { return }
        steer = ""
        DXHaptics.tap()
        Task {
            do { try await api.input(task: taskId, type: "steer", text: text) }
            catch { sendError = error.localizedDescription }
        }
    }
}

// MARK: - Event rendering

struct EventView: View {
    let event: [String: AnyCodable]
    let taskId: String

    var body: some View {
        switch event["type"]?.string {
        case "item":
            itemView(event["item"]?.obj ?? [:])
        case "approval":
            ApprovalCard(event: event, taskId: taskId)
        case "status":
            statusLine(event["status"]?.string ?? "")
        case "ready":
            EmptyView()
        case "done":
            Banner(icon: "checkmark.circle", text: event["result"]?.obj?["summary"] as? String ?? "Done",
                   tint: Color(UIColor.dx(light: 0x16a34a, dark: 0x4ade80)))
        case "denied":
            Banner(icon: "hand.raised", text: "\(event["tool"]?.string ?? "tool") denied — \(event["reason"]?.string ?? "")", tint: .dxFaint)
        case "exit", "error":
            Banner(icon: "xmark.octagon", text: event["error"]?.string ?? event["message"]?.string ?? "Failed", tint: .dxRed)
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private func itemView(_ item: [String: Any]) -> some View {
        let k = item["k"] as? String
        switch k {
        case "text":
            Text(item["text"] as? String ?? "")
                .font(.body)
                .foregroundStyle(Color.dxText)
                .frame(maxWidth: .infinity, alignment: .leading)
        case "think":
            Text(item["text"] as? String ?? "")
                .font(.caption.italic())
                .foregroundStyle(Color.dxFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
        case "tool":
            toolRow(item)
        case "diff":
            diffCard(item)
        case "plan":
            planCard(item)
        case "note":
            Text(item["text"] as? String ?? "")
                .font(.caption)
                .foregroundStyle(Color.dxFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
        default:
            EmptyView()
        }
    }

    private func toolRow(_ item: [String: Any]) -> some View {
        let name = item["name"] as? String ?? "tool"
        let args = (item["args"] as? [String: Any])
            .map { $0.sorted { $0.key < $1.key }.prefix(2).map { "\($0.key)=\($0.value)" }.joined(separator: " ") } ?? ""
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "chevron.right")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(Color.dxFaint)
            Text(args.isEmpty ? name : "\(name) \(args)")
                .font(.dxMonoSmall)
                .foregroundStyle(Color.dxFaint)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 2)
    }

    private func diffCard(_ item: [String: Any]) -> some View {
        let files = (item["files"] as? [[String: Any]]) ?? []
        let name = files.first?["path"] as? String ?? item["path"] as? String ?? "file changed"
        return HStack(spacing: 8) {
            Image(systemName: "doc.badge.plus")
                .font(.caption)
                .foregroundStyle(Color.dxFaint)
            VStack(alignment: .leading, spacing: 2) {
                Text((name as NSString).lastPathComponent)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Color.dxText)
                if files.count > 1 {
                    Text("+\(files.count - 1) more").font(.caption2).foregroundStyle(Color.dxFaint)
                } else {
                    Text(name).font(.dxMonoSmall).foregroundStyle(Color.dxFaint).lineLimit(1)
                }
            }
            Spacer()
        }
        .padding(10)
        .dxCard()
    }

    private func planCard(_ item: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PLAN").font(.dxGroupLabel).tracking(1.1).foregroundStyle(Color.dxFaint.opacity(0.75))
            if let steps = item["steps"] as? [[String: Any]] {
                ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(i + 1).").font(.dxMonoSmall).foregroundStyle(Color.dxFaint)
                        Text(s["title"] as? String ?? s["desc"] as? String ?? "")
                            .font(.callout).foregroundStyle(Color.dxText)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .dxCard()
    }

    private func statusLine(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(Color.dxFaint.opacity(0.8))
            .frame(maxWidth: .infinity, alignment: .center)
    }
}

struct Banner: View {
    let icon: String
    let text: String
    let tint: Color
    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption)
            .foregroundStyle(tint)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .dxCard()
    }
}

// MARK: - Approval card

struct ApprovalCard: View {
    let event: [String: AnyCodable]
    let taskId: String
    @EnvironmentObject var app: AppModel
    @State private var resolved = false
    @State private var editing = false
    @State private var draft: [PlanStep] = []
    @State private var error: String?

    struct PlanStep: Identifiable {
        let id = UUID()
        var title: String
        var desc: String
    }

    private var approvalId: Int? { event["id"]?.int }
    private var detail: [String: Any] { event["detail"]?.obj ?? [:] }
    private var kind: String { detail["kind"] as? String ?? "command" }
    private var planSteps: [[String: Any]] { detail["plan"] as? [[String: Any]] ?? [] }
    private var amber: Color { Color(UIColor.dx(light: 0xd97706, dark: 0xfbbf24)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("APPROVAL · \(kind.uppercased())")
                    .font(.dxGroupLabel).tracking(1.1)
                    .foregroundStyle(amber)
                Spacer()
                if let id = approvalId { Text("#\(id)").font(.dxMonoSmall).foregroundStyle(Color.dxFaint) }
            }

            if kind == "plan", !planSteps.isEmpty {
                if editing {
                    ForEach($draft) { $step in
                        VStack(spacing: 4) {
                            TextField("Step title", text: $step.title)
                                .font(.callout.weight(.medium))
                            TextField("Details (optional)", text: $step.desc)
                                .font(.caption)
                                .foregroundStyle(Color.dxFaint)
                        }
                        .padding(.vertical, 4)
                        Divider().overlay(Color.dxBorder.opacity(0.5))
                    }
                } else {
                    ForEach(Array(planSteps.enumerated()), id: \.offset) { i, s in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(i + 1).").font(.dxMonoSmall).foregroundStyle(Color.dxFaint)
                            Text(s["title"] as? String ?? s["desc"] as? String ?? "")
                                .font(.callout).foregroundStyle(Color.dxText)
                        }
                    }
                }
            } else if let cmd = (detail["input"] as? [String: Any])?["command"] as? String
                        ?? detail["command"] as? String {
                VStack(alignment: .leading, spacing: 4) {
                    Text(cmd)
                        .font(.dxMonoSmall)
                        .foregroundStyle(Color.dxText)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.dxSurface2)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    if let reason = detail["reason"] as? String {
                        Text(reason).font(.caption2).foregroundStyle(Color.dxFaint)
                    }
                }
            } else if let desc = detail["reason"] as? String ?? detail["description"] as? String ?? detail["title"] as? String {
                Text(desc).font(.callout).foregroundStyle(Color.dxText)
            }

            if let error { Text(error).font(.caption2).foregroundStyle(Color.dxRed) }

            if resolved {
                Label("answered", systemImage: "checkmark")
                    .font(.caption).foregroundStyle(Color.dxFaint)
            } else {
                Button {
                    editing ? sendPlanEdit() : answer("y")
                } label: {
                    Text(editing ? "Approve edited plan" : "Approve")
                }
                .buttonStyle(DXPrimaryButton())

                HStack(spacing: 10) {
                    Button("Deny") { answer("n") }.buttonStyle(DXSecondaryButton())
                    if kind == "command" || kind == "tool" {
                        Button("Always") { answer("a") }.buttonStyle(DXSecondaryButton())
                    }
                    if kind == "plan", !planSteps.isEmpty {
                        Spacer()
                        Button(editing ? "Cancel edit" : "Edit steps…") {
                            DXHaptics.tap()
                            if editing { editing = false } else { startEdit() }
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.dxFaint)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .dxCard()
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(amber.opacity(resolved ? 0 : 0.35), lineWidth: 1)
        )
        .opacity(resolved ? 0.6 : 1)
    }

    private func startEdit() {
        draft = planSteps.map {
            PlanStep(title: $0["title"] as? String ?? "", desc: $0["desc"] as? String ?? "")
        }
        editing = true
    }

    private func answer(_ choice: String) {
        guard let api = app.api else { return }
        DXHaptics.tap()
        Task {
            do {
                try await api.input(task: taskId, type: "approve", id: approvalId, choice: choice)
                resolved = true
                DXHaptics.confirm()
            } catch { self.error = error.localizedDescription }
        }
    }

    private func sendPlanEdit() {
        guard let api = app.api else { return }
        let steps = draft.map { ["title": AnyCodable($0.title), "desc": AnyCodable($0.desc)] }
        let plan: [String: AnyCodable] = ["steps": AnyCodable(steps)]
        DXHaptics.tap()
        Task {
            do {
                try await api.input(task: taskId, type: "approve", id: approvalId, choice: "y", plan: plan)
                resolved = true
                DXHaptics.confirm()
            } catch { self.error = error.localizedDescription }
        }
    }
}
