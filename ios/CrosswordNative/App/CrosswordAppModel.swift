import Foundation

@MainActor
final class CrosswordAppModel: ObservableObject {
  @Published var puzzleIndex: [PuzzleMeta] = []
  @Published var homeMode: PuzzleMode
  @Published var isLoadingIndex = false
  @Published var errorMessage: String?

  init(homeMode: PuzzleMode = SoloStore.shared.loadHomeMode()) {
    self.homeMode = homeMode
  }

  func loadIndex() async {
    guard !isLoadingIndex else { return }
    isLoadingIndex = true
    defer { isLoadingIndex = false }
    do {
      puzzleIndex = try await CrosswordAPI.shared.fetchPuzzleIndex().sorted { $0.date > $1.date }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func setHomeMode(_ mode: PuzzleMode) {
    homeMode = mode
    SoloStore.shared.saveHomeMode(mode)
  }
}
