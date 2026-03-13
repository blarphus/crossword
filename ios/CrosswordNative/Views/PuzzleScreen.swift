import SwiftUI

enum EntryDirection: String, CaseIterable {
  case across
  case down

  mutating func toggle() {
    self = self == .across ? .down : .across
  }
}

@MainActor
final class PuzzleViewModel: ObservableObject {
  @Published var puzzle: PuzzlePayload?
  @Published var answers: [String: String] = [:]
  @Published var selected = GridPosition(row: 0, col: 0)
  @Published var direction: EntryDirection = .across
  @Published var isLoading = false
  @Published var errorMessage: String?
  @Published var elapsedSeconds = 0

  let date: String
  let mode: PuzzleMode

  private var timerTask: Task<Void, Never>?
  private var loadedAt = Date()

  init(date: String, mode: PuzzleMode) {
    self.date = date
    self.mode = mode
  }

  deinit {
    timerTask?.cancel()
  }

  func load() async {
    guard !isLoading else { return }
    isLoading = true
    defer { isLoading = false }
    do {
      let payload = try await CrosswordAPI.shared.fetchPuzzle(date)
      puzzle = payload
      switch mode {
      case .local:
        let saved = SoloStore.shared.loadState(for: date)
        answers = saved?.answers ?? [:]
        elapsedSeconds = saved?.elapsedSeconds ?? 0
      case .communal:
        let shared = try await CrosswordAPI.shared.fetchSharedState(date)
        answers = shared.userGrid
        elapsedSeconds = 0
      }
      selectFirstOpenCell()
      loadedAt = .now
      startTimer()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func refreshCommunal() async {
    guard mode == .communal else { return }
    do {
      let shared = try await CrosswordAPI.shared.fetchSharedState(date)
      answers = shared.userGrid
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func clear() async {
    answers = [:]
    if mode == .local {
      persistLocal()
    } else {
      do {
        try await CrosswordAPI.shared.clearSharedState(date)
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  func onDisappear() {
    timerTask?.cancel()
    persistLocal()
  }

  func select(row: Int, col: Int) {
    guard !isBlack(row: row, col: col) else { return }
    if selected.row == row, selected.col == col {
      direction.toggle()
      if clueForCell(row: row, col: col, direction: direction) == nil {
        direction.toggle()
      }
    } else {
      selected = GridPosition(row: row, col: col)
      if clueForCell(row: row, col: col, direction: direction) == nil {
        direction.toggle()
      }
    }
  }

  func insert(letter: String) {
    guard let puzzle else { return }
    let trimmed = String(letter.prefix(1)).uppercased()
    guard !trimmed.isEmpty else { return }
    guard !isBlack(row: selected.row, col: selected.col) else { return }
    answers[selected.key] = trimmed
    if mode == .local {
      persistLocal()
    } else {
      Task { try? await CrosswordAPI.shared.updateSharedCell(date: date, row: selected.row, col: selected.col, letter: trimmed) }
    }
    moveCursor(forward: true, in: puzzle)
  }

  func backspace() {
    guard puzzle != nil else { return }
    if !(answers[selected.key] ?? "").isEmpty {
      answers[selected.key] = ""
      if mode == .local {
        persistLocal()
      } else {
        Task { try? await CrosswordAPI.shared.updateSharedCell(date: date, row: selected.row, col: selected.col, letter: "") }
      }
      return
    }
    moveCursor(forward: false, in: puzzle!)
    answers[selected.key] = ""
    if mode == .local {
      persistLocal()
    } else {
      Task { try? await CrosswordAPI.shared.updateSharedCell(date: date, row: selected.row, col: selected.col, letter: "") }
    }
  }

  func moveClue(forward: Bool) {
    guard let puzzle, let currentClue = clueForCell(row: selected.row, col: selected.col, direction: direction) else { return }
    let clues = direction == .across ? puzzle.clues.across : puzzle.clues.down
    guard let index = clues.firstIndex(of: currentClue), !clues.isEmpty else { return }
    let nextIndex = (index + (forward ? 1 : clues.count - 1)) % clues.count
    let next = clues[nextIndex]
    selected = GridPosition(row: next.row, col: next.col)
  }

  func currentClueText() -> String {
    guard let clue = clueForCell(row: selected.row, col: selected.col, direction: direction) else { return "" }
    return "\(clue.number) \(direction == .across ? "Across" : "Down"): \(clue.clue)"
  }

  func isSelected(row: Int, col: Int) -> Bool {
    selected.row == row && selected.col == col
  }

  func isInSelectedClue(row: Int, col: Int) -> Bool {
    guard let clue = clueForCell(row: selected.row, col: selected.col, direction: direction) else { return false }
    return clueCells(for: clue, direction: direction).contains(GridPosition(row: row, col: col))
  }

  func clueSections() -> [(EntryDirection, [PuzzleClue])] {
    guard let puzzle else { return [] }
    return [(.across, puzzle.clues.across), (.down, puzzle.clues.down)]
  }

  func isActiveClue(_ clue: PuzzleClue, direction candidate: EntryDirection) -> Bool {
    guard let current = clueForCell(row: selected.row, col: selected.col, direction: candidate) else { return false }
    return current == clue && self.direction == candidate
  }

  func jump(to clue: PuzzleClue, direction: EntryDirection) {
    self.direction = direction
    selected = GridPosition(row: clue.row, col: clue.col)
  }

  func letterAt(row: Int, col: Int) -> String {
    answers["\(row),\(col)"] ?? ""
  }

  func numberAt(row: Int, col: Int) -> Int {
    puzzle?.cellNumbers[row][col] ?? 0
  }

  func isCorrect(row: Int, col: Int) -> Bool {
    guard let puzzle else { return false }
    let answer = answers["\(row),\(col)"] ?? ""
    guard !answer.isEmpty else { return false }
    return answer == correctAnswer(row: row, col: col, in: puzzle)
  }

  private func selectFirstOpenCell() {
    guard let puzzle else { return }
    for row in 0 ..< puzzle.dimensions.rows {
      for col in 0 ..< puzzle.dimensions.cols where !isBlack(row: row, col: col) {
        selected = GridPosition(row: row, col: col)
        return
      }
    }
  }

  private func isBlack(row: Int, col: Int) -> Bool {
    puzzle?.grid[row][col] == "."
  }

  private func correctAnswer(row: Int, col: Int, in puzzle: PuzzlePayload) -> String {
    puzzle.rebus?["\(row),\(col)"] ?? puzzle.grid[row][col]
  }

  private func moveCursor(forward: Bool, in puzzle: PuzzlePayload) {
    switch direction {
    case .across:
      var col = selected.col + (forward ? 1 : -1)
      while col >= 0, col < puzzle.dimensions.cols, puzzle.grid[selected.row][col] == "." {
        col += forward ? 1 : -1
      }
      if col >= 0, col < puzzle.dimensions.cols {
        selected = GridPosition(row: selected.row, col: col)
      }
    case .down:
      var row = selected.row + (forward ? 1 : -1)
      while row >= 0, row < puzzle.dimensions.rows, puzzle.grid[row][selected.col] == "." {
        row += forward ? 1 : -1
      }
      if row >= 0, row < puzzle.dimensions.rows {
        selected = GridPosition(row: row, col: selected.col)
      }
    }
  }

  private func clueForCell(row: Int, col: Int, direction: EntryDirection) -> PuzzleClue? {
    guard let puzzle else { return nil }
    let clues = direction == .across ? puzzle.clues.across : puzzle.clues.down
    return clues.first(where: { clueCells(for: $0, direction: direction).contains(GridPosition(row: row, col: col)) })
  }

  private func clueCells(for clue: PuzzleClue, direction: EntryDirection) -> [GridPosition] {
    guard let puzzle else { return [] }
    var result: [GridPosition] = []
    var row = clue.row
    var col = clue.col
    while row >= 0, row < puzzle.dimensions.rows, col >= 0, col < puzzle.dimensions.cols, puzzle.grid[row][col] != "." {
      result.append(GridPosition(row: row, col: col))
      switch direction {
      case .across: col += 1
      case .down: row += 1
      }
    }
    return result
  }

  private func startTimer() {
    timerTask?.cancel()
    timerTask = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled else { return }
        elapsedSeconds += 1
      }
    }
  }

  private func persistLocal() {
    guard mode == .local, let puzzle else { return }
    let state = SavedPuzzleState(
      answers: answers.filter { !$0.value.isEmpty },
      elapsedSeconds: elapsedSeconds,
      summary: summary(for: puzzle),
      updatedAt: .now
    )
    SoloStore.shared.saveState(state, for: date)
  }

  private func summary(for puzzle: PuzzlePayload) -> PuzzleProgressSummary {
    var cells: [Int] = []
    var filled = 0
    var totalWhite = 0
    var isComplete = true
    for row in 0 ..< puzzle.dimensions.rows {
      for col in 0 ..< puzzle.dimensions.cols {
        if puzzle.grid[row][col] == "." {
          cells.append(0)
          continue
        }
        totalWhite += 1
        let key = "\(row),\(col)"
        let value = answers[key] ?? ""
        if value.isEmpty {
          cells.append(1)
          isComplete = false
        } else {
          cells.append(2)
          filled += 1
          if value != correctAnswer(row: row, col: col, in: puzzle) {
            isComplete = false
          }
        }
      }
    }
    if totalWhite == 0 { isComplete = false }
    return PuzzleProgressSummary(
      date: date,
      rows: puzzle.dimensions.rows,
      cols: puzzle.dimensions.cols,
      cells: cells,
      filledCount: filled,
      totalWhite: totalWhite,
      isComplete: isComplete
    )
  }
}

struct PuzzleScreen: View {
  @Environment(\.dismiss) private var dismiss
  @StateObject private var viewModel: PuzzleViewModel
  @State private var wantsKeyboard = true

  init(date: String, mode: PuzzleMode) {
    _viewModel = StateObject(wrappedValue: PuzzleViewModel(date: date, mode: mode))
  }

  var body: some View {
    Group {
      if let puzzle = viewModel.puzzle {
        ScrollView {
          VStack(spacing: 18) {
            header(puzzle: puzzle)
            clueBar
            grid(puzzle: puzzle)
            clueList(puzzle: puzzle)
          }
          .padding(16)
        }
        .background(Color(red: 0.97, green: 0.98, blue: 1.0))
        .safeAreaInset(edge: .bottom) {
          KeyCaptureField(isFirstResponder: wantsKeyboard, onInsert: viewModel.insert(letter:), onBackspace: viewModel.backspace)
            .frame(width: 1, height: 1)
            .opacity(0.01)
        }
      } else if viewModel.isLoading {
        ProgressView("Loading Puzzle")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        VStack(spacing: 16) {
          Text("Unable to load puzzle")
            .font(.headline)
          if let error = viewModel.errorMessage {
            Text(error)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          }
          Button("Close") { dismiss() }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("Refresh") {
            Task { await viewModel.load() }
          }
          if viewModel.mode == .communal {
            Button("Refresh Shared State") {
              Task { await viewModel.refreshCommunal() }
            }
          }
          Button("Clear Grid", role: .destructive) {
            Task { await viewModel.clear() }
          }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
      }
    }
    .task {
      await viewModel.load()
    }
    .onDisappear {
      viewModel.onDisappear()
    }
  }

  private func header(puzzle: PuzzlePayload) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 4) {
          Text(puzzle.title)
            .font(.title3.weight(.black))
          Text("\(formattedDate(viewModel.date)) · By \(puzzle.author)")
            .font(.subheadline)
            .foregroundStyle(.secondary)
          Text("Edited by \(puzzle.editor)")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 6) {
          Text(viewModel.mode.title)
            .font(.caption.weight(.bold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(viewModel.mode == .communal ? Color.blue.opacity(0.16) : Color.black.opacity(0.08))
            .clipShape(Capsule())
          Text(timerString(viewModel.elapsedSeconds))
            .font(.title3.monospacedDigit().weight(.semibold))
        }
      }
    }
  }

  private var clueBar: some View {
    VStack(spacing: 10) {
      HStack {
        Button(action: { viewModel.moveClue(forward: false) }) {
          Image(systemName: "chevron.left")
        }
        .buttonStyle(.bordered)
        Spacer()
        Text(viewModel.currentClueText())
          .font(.headline)
          .multilineTextAlignment(.center)
        Spacer()
        Button(action: { viewModel.moveClue(forward: true) }) {
          Image(systemName: "chevron.right")
        }
        .buttonStyle(.bordered)
      }

      HStack {
        Button(viewModel.direction == .across ? "Across" : "Down") {
          viewModel.direction.toggle()
        }
        .buttonStyle(.borderedProminent)
        .tint(.black)

        Spacer()

        Text("Tap a square twice to switch direction")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func grid(puzzle: PuzzlePayload) -> some View {
    GeometryReader { geometry in
      let side = min(geometry.size.width, geometry.size.height)
      let cellSize = side / CGFloat(puzzle.dimensions.cols)
      VStack(spacing: 0) {
        ForEach(0 ..< puzzle.dimensions.rows, id: \.self) { row in
          HStack(spacing: 0) {
            ForEach(0 ..< puzzle.dimensions.cols, id: \.self) { col in
              let isBlack = puzzle.grid[row][col] == "."
              Button {
                wantsKeyboard = true
                viewModel.select(row: row, col: col)
              } label: {
                ZStack(alignment: .topLeading) {
                  Rectangle()
                    .fill(cellBackground(row: row, col: col, isBlack: isBlack))
                  if !isBlack {
                    if viewModel.numberAt(row: row, col: col) > 0 {
                      Text("\(viewModel.numberAt(row: row, col: col))")
                        .font(.system(size: max(8, cellSize * 0.22), weight: .semibold))
                        .foregroundStyle(.black.opacity(0.85))
                        .padding(.top, 3)
                        .padding(.leading, 3)
                    }
                    Text(viewModel.letterAt(row: row, col: col))
                      .font(.system(size: max(15, cellSize * 0.54), weight: .black, design: .default))
                      .foregroundStyle(viewModel.isCorrect(row: row, col: col) ? Color.black : Color.black)
                  }
                }
                .frame(width: cellSize, height: cellSize)
                .overlay(Rectangle().stroke(Color.black.opacity(0.28), lineWidth: 0.7))
              }
              .buttonStyle(.plain)
            }
          }
        }
      }
      .frame(width: side, height: side)
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(Color.black, lineWidth: 3)
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .frame(height: min(UIScreen.main.bounds.width - 32, 420))
  }

  private func clueList(puzzle: PuzzlePayload) -> some View {
    VStack(alignment: .leading, spacing: 18) {
      ForEach(viewModel.clueSections(), id: \.0.rawValue) { direction, clues in
        VStack(alignment: .leading, spacing: 10) {
          Text(direction == .across ? "Across" : "Down")
            .font(.title3.weight(.black))
          ForEach(clues) { clue in
            Button {
              wantsKeyboard = true
              viewModel.jump(to: clue, direction: direction)
            } label: {
              HStack(alignment: .top, spacing: 10) {
                Text("\(clue.number)")
                  .font(.headline.monospacedDigit())
                  .foregroundStyle(.secondary)
                  .frame(width: 28, alignment: .leading)
                Text(clue.clue)
                  .font(.body.weight(viewModel.isActiveClue(clue, direction: direction) ? .bold : .regular))
                  .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
              }
              .padding(12)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                  .fill(viewModel.isActiveClue(clue, direction: direction) ? Color.blue.opacity(0.14) : Color.white)
              )
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
  }

  private func cellBackground(row: Int, col: Int, isBlack: Bool) -> Color {
    if isBlack { return .black }
    if viewModel.isSelected(row: row, col: col) { return Color(red: 1.0, green: 0.9, blue: 0.24) }
    if viewModel.isInSelectedClue(row: row, col: col) { return Color(red: 0.74, green: 0.89, blue: 1.0) }
    return .white
  }

  private func formattedDate(_ date: String) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    guard let parsed = formatter.date(from: date) else { return date }
    return parsed.formatted(.dateTime.weekday(.wide).month(.wide).day().year())
  }

  private func timerString(_ totalSeconds: Int) -> String {
    let hours = totalSeconds / 3600
    let minutes = (totalSeconds % 3600) / 60
    let seconds = totalSeconds % 60
    if hours > 0 {
      return String(format: "%d:%02d:%02d", hours, minutes, seconds)
    }
    return String(format: "%d:%02d", minutes, seconds)
  }
}
