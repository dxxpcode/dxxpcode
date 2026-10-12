import SwiftUI

// Screen 3 — live transcript for one task over SSE: items (text/tool/diff/
// plan), approval cards with approve/deny/always + plan edit, steer composer.
struct TaskDetailView: View {
    let taskId: String
    @EnvironmentObject var app: AppModel
    @State private var events: [DxxpAPI.SSEvent] = []
    @State private var lastEventId: Int?
    @State private var status = "connecting"
    @State private var steer = ""
    @State private var sendError: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(events.enumerated()), id: \.offset) { _, ev in
                            EventView(event: ev.json, taskId: taskId)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .id("bottom")
                }
                .onChange(of: events.count) {
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom") }
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
                Text(status).font(.caption2).foregroundStyle(Color.dxFaint)
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
                .font(.callout)
                .foregroundStyle(Color.dxText)
                .frame(maxWidth: .infinity, alignment: .leading)
        case "think":
            Text(item["text"] as? String ?? "")
                .font(.caption)
                .foregroundStyle(Color.dxFaint)
                .italic()
                .frame(maxWidth: .infinity, alignment: .leading)
        case "tool":
            let name = item["name"] as? String ?? "tool"
            let args = (item["args"] as? [String: Any])
                .map { $0.sorted { $0.key < $1.key }.prefix(2).map { "\($0.key)=\($0.value)" }.joined(separator: " ") } ?? ""
            Label("\(name) \(args)", systemImage: "wrench.and.screwdriver")
                .font(.dxMonoSmall)
                .foregroundStyle(Color.dxFaint)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        case "diff":
            let files = (item["files"] as? [[String: Any]])?.map { "\($0["path"] ?? "")" } ?? []
            Label(files.isEmpty ? (item["path"] as? String ?? "file changed") : files.joined(separator: ", "),
                  systemImage: "doc.badge.plus")
                .font(.dxMonoSmall)
                .foregroundStyle(Color.dxText)
                .lineLimit(2)
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
    @State private var editingPlan = false
    @State private var planDraft = ""
    @State private var error: String?

    private var approvalId: Int? { event["id"]?.int }
    private var detail: [String: Any] { event["detail"]?.obj ?? [:] }
    private var kind: String { detail["kind"] as? String ?? "command" }
    private var planSteps: [[String: Any]] { detail["plan"] as? [[String: Any]] ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("APPROVAL · \(kind.uppercased())")
                    .font(.dxGroupLabel).tracking(1.1)
                    .foregroundStyle(Color(UIColor.dx(light: 0xd97706, dark: 0xfbbf24)))
                Spacer()
                if let id = approvalId { Text("#\(id)").font(.dxMonoSmall).foregroundStyle(Color.dxFaint) }
            }

            if kind == "plan", !planSteps.isEmpty {
                ForEach(Array(planSteps.enumerated()), id: \.offset) { i, s in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(i + 1).").font(.dxMonoSmall).foregroundStyle(Color.dxFaint)
                        Text(s["title"] as? String ?? s["desc"] as? String ?? "")
                            .font(.callout).foregroundStyle(Color.dxText)
                    }
                }
            } else if let cmd = detail["command"] as? String {
                Text(cmd)
                    .font(.dxMonoSmall)
                    .foregroundStyle(Color.dxText)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.dxSurface2)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else if let desc = detail["description"] as? String ?? detail["title"] as? String {
                Text(desc).font(.callout).foregroundStyle(Color.dxText)
            }

            if editingPlan {
                TextEditor(text: $planDraft)
                    .font(.dxMonoSmall)
                    .frame(minHeight: 90)
                    .padding(6)
                    .background(Color.dxSurface2)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.dxBorder, lineWidth: 0.5))
                Text("JSON plan object — same shape as plan.md").font(.caption2).foregroundStyle(Color.dxFaint)
            }

            if let error { Text(error).font(.caption2).foregroundStyle(Color.dxRed) }

            if resolved {
                Label("answered", systemImage: "checkmark")
                    .font(.caption).foregroundStyle(Color.dxFaint)
            } else {
                HStack(spacing: 10) {
                    answerButton("Approve", choice: "y", prominent: true)
                    answerButton("Deny", choice: "n")
                    if kind == "command" { answerButton("Always", choice: "a") }
                    if kind == "plan" {
                        Button(editingPlan ? "Send edit" : "Edit…") { sendPlanEdit() }
                            .font(.caption.weight(.medium))
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .dxCard()
        .opacity(resolved ? 0.6 : 1)
    }

    private func answerButton(_ label: String, choice: String, prominent: Bool = false) -> some View {
        Button {
            answer(choice)
        } label: {
            Text(label)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 14).padding(.vertical, 7)
        }
        .buttonStyle(.bordered)
        .tint(prominent ? Color.dxText : Color.dxFaint)
    }

    private func answer(_ choice: String) {
        guard let api = app.api else { return }
        Task {
            do {
                try await api.input(task: taskId, type: "approve", id: approvalId, choice: choice)
                resolved = true
            } catch { self.error = error.localizedDescription }
        }
    }

    private func sendPlanEdit() {
        if editingPlan {
            guard let api = app.api,
                  let data = planDraft.data(using: .utf8),
                  let obj = try? JSONDecoder().decode([String: AnyCodable].self, from: data)
            else { error = "Invalid JSON"; return }
            Task {
                do {
                    try await api.input(task: taskId, type: "approve", id: approvalId, choice: "y", plan: obj)
                    resolved = true
                } catch { self.error = error.localizedDescription }
            }
        } else {
            let steps = planSteps.map { ["title": $0["title"] ?? "", "desc": $0["desc"] ?? ""] }
            planDraft = String(data: (try? JSONSerialization.data(withJSONObject: ["steps": steps], options: .prettyPrinted)) ?? Data(), encoding: .utf8) ?? ""
            editingPlan = true
        }
    }
}
