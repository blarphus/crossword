import Foundation

@MainActor
final class SoloStore {
  static let shared = SoloStore()

  private let defaults = UserDefaults.standard
  private let statePrefix = "ios-crossword-solo-state:"
  private let modeKey = "ios-crossword-home-mode"

  func loadHomeMode() -> PuzzleMode {
    guard let raw = defaults.string(forKey: modeKey), let mode = PuzzleMode(rawValue: raw) else {
      return .communal
    }
    return mode
  }

  func saveHomeMode(_ mode: PuzzleMode) {
    defaults.set(mode.rawValue, forKey: modeKey)
  }

  func loadState(for date: String) -> SavedPuzzleState? {
    guard let data = defaults.data(forKey: statePrefix + date) else { return nil }
    return try? JSONDecoder().decode(SavedPuzzleState.self, from: data)
  }

  func saveState(_ state: SavedPuzzleState, for date: String) {
    guard let data = try? JSONEncoder().encode(state) else { return }
    defaults.set(data, forKey: statePrefix + date)
  }

  func clearState(for date: String) {
    defaults.removeObject(forKey: statePrefix + date)
  }
}
