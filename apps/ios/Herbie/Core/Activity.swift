import Foundation

struct Activity: Identifiable {
  var id: String
  var type: String
  var fields: [String: Any]
  var text: String {
    switch type {
    case "agentMessage", "plan": return fields["text"] as? String ?? ""
    case "reasoning":
      return ["summary", "content"].flatMap { fields[$0] as? [String] ?? [] }.joined(
        separator: "\n\n")
    case "commandExecution":
      return [
        fields["command"] as? String, fields["aggregatedOutput"] as? String,
        (fields["exitCode"] as? Int).map { "Exit code: \($0)" },
      ].compactMap { $0 }.joined(separator: "\n")
    default:
      guard
        let data = try? JSONSerialization.data(
          withJSONObject: fields, options: [.prettyPrinted, .sortedKeys])
      else { return "" }
      return String(decoding: data, as: UTF8.self)
    }
  }
  static func assemble(_ events: [ProjectEvent]) -> [Activity] {
    var order: [String] = []
    var items: [String: Activity] = [:]
    for event in events where event.type == "agent" {
      guard let data = event.message.data(using: .utf8),
        let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let params = message["params"] as? [String: Any]
      else { continue }
      let prefix = "\(params["threadId"] as? String ?? ""):\(params["turnId"] as? String ?? ""):"
      if let item = params["item"] as? [String: Any], let id = item["id"] as? String,
        let type = item["type"] as? String
      {
        let key = prefix + id
        if items[key] == nil { order.append(key) }
        items[key] = Activity(id: key, type: type, fields: item)
      } else if let id = params["itemId"] as? String, let delta = params["delta"] as? String {
        let key = prefix + id
        let method = message["method"] as? String ?? ""
        let reasoning = method.hasPrefix("item/reasoning/")
        let output = method == "item/commandExecution/outputDelta"
        if items[key] == nil {
          order.append(key)
          items[key] = Activity(
            id: key, type: reasoning ? "reasoning" : output ? "commandExecution" : "agentMessage",
            fields: [:])
        }
        if reasoning {
          let field = method == "item/reasoning/textDelta" ? "content" : "summary"
          let index = params[field == "content" ? "contentIndex" : "summaryIndex"] as? Int ?? 0
          guard index >= 0 && index < 10000 else { continue }
          var blocks = items[key]?.fields[field] as? [String] ?? []
          while blocks.count <= index { blocks.append("") }
          blocks[index] += delta
          items[key]?.fields[field] = blocks
        } else {
          let field = output ? "aggregatedOutput" : "text"
          let previous = items[key]?.fields[field] as? String ?? ""
          items[key]?.fields[field] = previous + delta
        }
      }
    }
    return order.compactMap { items[$0] }
  }
}
