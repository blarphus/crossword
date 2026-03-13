import Foundation

enum PuzzleMode: String, CaseIterable, Identifiable, Codable {
  case communal
  case local

  var id: String { rawValue }

  var title: String {
    switch self {
    case .communal: "Communal"
    case .local: "Local"
    }
  }

  var description: String {
    switch self {
    case .communal: "Shared backend grid"
    case .local: "Saved on this device"
    }
  }
}

struct PuzzleMeta: Decodable, Identifiable, Hashable {
  let date: String
  let title: String
  let author: String
  let editor: String
  let dimensions: PuzzleDimensions

  var id: String { date }
}

struct PuzzleDimensions: Decodable, Hashable {
  let cols: Int
  let rows: Int
}

struct PuzzleClue: Decodable, Hashable, Identifiable {
  let number: Int
  let clue: String
  let answer: String
  let row: Int
  let col: Int

  var id: String { "\(number)-\(row)-\(col)-\(clue)" }
}

struct PuzzleClueGroups: Decodable, Hashable {
  let across: [PuzzleClue]
  let down: [PuzzleClue]
}

struct PuzzlePayload: Decodable {
  let date: String
  let title: String
  let author: String
  let editor: String
  let dimensions: PuzzleDimensions
  let grid: [[String]]
  let cellNumbers: [[Int]]
  let clues: PuzzleClueGroups
  let rebus: [String: String]?
}

struct SharedStatePayload: Decodable {
  let userGrid: [String: String]
  let cellFillers: [String: String]
  let points: [String: Int]
  let guesses: [String: GuessStat]
  let userColors: [String: String]
  let updatedAt: String?
}

struct GuessStat: Decodable {
  let total: Int?
  let incorrect: Int?
}

struct CalendarTemplate: Decodable, Identifiable {
  let date: String
  let rows: Int
  let cols: Int
  let cells: [Int]
  let filledCount: Int
  let totalWhite: Int
  let isComplete: Bool

  var id: String { date }
}

struct PuzzleProgressSummary: Codable, Identifiable, Hashable {
  let date: String
  let rows: Int
  let cols: Int
  let cells: [Int]
  let filledCount: Int
  let totalWhite: Int
  let isComplete: Bool

  var id: String { date }
}

struct SavedPuzzleState: Codable {
  let answers: [String: String]
  let elapsedSeconds: Int
  let summary: PuzzleProgressSummary
  let updatedAt: Date
}

struct GridPosition: Hashable {
  let row: Int
  let col: Int

  var key: String { "\(row),\(col)" }
}
