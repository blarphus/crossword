import SwiftUI

private func normalizedSummary(from template: CalendarTemplate) -> PuzzleProgressSummary {
  PuzzleProgressSummary(
    date: template.date,
    rows: template.rows,
    cols: template.cols,
    cells: template.cells.map { $0 == 0 ? 0 : 1 },
    filledCount: 0,
    totalWhite: template.totalWhite,
    isComplete: false
  )
}

private func communalSummary(template: CalendarTemplate, shared: SharedStatePayload) -> PuzzleProgressSummary {
  var cells: [Int] = []
  var filledCount = 0
  for idx in template.cells.indices {
    let base = template.cells[idx]
    if base == 0 {
      cells.append(0)
      continue
    }
    let row = idx / template.cols
    let col = idx % template.cols
    let hasLetter = !(shared.userGrid["\(row),\(col)"] ?? "").isEmpty
    cells.append(hasLetter ? 2 : 1)
    if hasLetter { filledCount += 1 }
  }
  return PuzzleProgressSummary(
    date: template.date,
    rows: template.rows,
    cols: template.cols,
    cells: cells,
    filledCount: filledCount,
    totalWhite: template.totalWhite,
    isComplete: template.totalWhite > 0 && filledCount >= template.totalWhite
  )
}

struct CalendarScreen: View {
  @EnvironmentObject private var appModel: CrosswordAppModel
  @State private var monthDate = Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: .now)) ?? .now
  @State private var monthTemplates: [CalendarTemplate] = []
  @State private var monthSummaries: [String: PuzzleProgressSummary] = [:]
  @State private var isLoadingMonth = false

  private let calendar = Calendar.current
  private let weekdaySymbols = ["S", "M", "T", "W", "T", "F", "S"]

  var body: some View {
    VStack(spacing: 16) {
      header
      weekdayHeader
      calendarGrid
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.top, 16)
    .navigationBarTitleDisplayMode(.inline)
    .task(id: monthLoadKey) {
      await loadMonth()
    }
    .refreshable {
      await appModel.loadIndex()
      await loadMonth(force: true)
    }
    .alert("Unable to Load", isPresented: .constant(appModel.errorMessage != nil && appModel.puzzleIndex.isEmpty), actions: {
      Button("Retry") {
        Task { await appModel.loadIndex() }
      }
    }, message: {
      Text(appModel.errorMessage ?? "Unknown error")
    })
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 14) {
        Image("BrandMark")
          .resizable()
          .scaledToFit()
          .frame(width: 56, height: 56)
          .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

        VStack(alignment: .leading, spacing: 4) {
          Text("The Crossword")
            .font(.system(size: 32, weight: .black, design: .default))
          Text("A native client for your live crossword backend")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)
        }
      }

      Picker("Mode", selection: Binding(
        get: { appModel.homeMode },
        set: { newValue in
          appModel.setHomeMode(newValue)
        }
      )) {
        ForEach(PuzzleMode.allCases) { mode in
          Text(mode.title).tag(mode)
        }
      }
      .pickerStyle(.segmented)

      HStack {
        Button(action: previousMonth) {
          Image(systemName: "chevron.left")
            .font(.headline.weight(.semibold))
        }
        .buttonStyle(.bordered)

        Spacer()

        VStack(spacing: 2) {
          Text(monthTitle)
            .font(.title3.weight(.bold))
          Text(appModel.homeMode.description)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
        }

        Spacer()

        Button(action: nextMonth) {
          Image(systemName: "chevron.right")
            .font(.headline.weight(.semibold))
        }
        .buttonStyle(.bordered)
      }
    }
  }

  private var weekdayHeader: some View {
    HStack(spacing: 8) {
      ForEach(weekdaySymbols, id: \.self) { symbol in
        Text(symbol)
          .font(.caption.weight(.bold))
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
      }
    }
  }

  private var calendarGrid: some View {
    let days = dayItems()
    return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 8) {
      ForEach(days.indices, id: \.self) { idx in
        if let day = days[idx] {
          if puzzleMeta(for: day) != nil {
            NavigationLink {
              PuzzleScreen(date: day, mode: appModel.homeMode)
            } label: {
              DayCell(
                dayNumber: dayNumber(day),
                summary: monthSummaries[day],
                isToday: isToday(day),
                isLoading: isLoadingMonth && monthSummaries[day] == nil
              )
            }
            .buttonStyle(.plain)
          } else {
            DayCell(dayNumber: dayNumber(day), summary: nil, isToday: false, isDimmed: true)
          }
        } else {
          Color.clear
            .frame(height: 74)
        }
      }
    }
  }

  private var monthLoadKey: String {
    "\(yearMonthString(monthDate))-\(appModel.homeMode.rawValue)-\(appModel.puzzleIndex.count)"
  }

  private var monthTitle: String {
    monthDate.formatted(.dateTime.month(.wide).year())
  }

  private func previousMonth() {
    monthDate = calendar.date(byAdding: .month, value: -1, to: monthDate) ?? monthDate
  }

  private func nextMonth() {
    monthDate = calendar.date(byAdding: .month, value: 1, to: monthDate) ?? monthDate
  }

  private func puzzleMeta(for date: String) -> PuzzleMeta? {
    appModel.puzzleIndex.first(where: { $0.date == date })
  }

  private func dayNumber(_ date: String) -> String {
    date.split(separator: "-").last.map(String.init) ?? ""
  }

  private func isToday(_ date: String) -> Bool {
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: .now) == date
  }

  private func yearMonthString(_ date: Date) -> String {
    let comps = calendar.dateComponents([.year, .month], from: date)
    return String(format: "%04d-%02d", comps.year ?? 0, comps.month ?? 0)
  }

  private func dayItems() -> [String?] {
    guard
      let monthInterval = calendar.dateInterval(of: .month, for: monthDate),
      let monthRange = calendar.range(of: .day, in: .month, for: monthDate)
    else {
      return []
    }

    let firstWeekday = calendar.component(.weekday, from: monthInterval.start) - 1
    var items = Array(repeating: Optional<String>.none, count: firstWeekday)

    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.dateFormat = "yyyy-MM-dd"

    for day in monthRange {
      guard let date = calendar.date(byAdding: .day, value: day - 1, to: monthInterval.start) else { continue }
      items.append(formatter.string(from: date))
    }

    while items.count % 7 != 0 {
      items.append(nil)
    }
    return items
  }

  private func loadMonth(force: Bool = false) async {
    let yearMonth = yearMonthString(monthDate)
    isLoadingMonth = true
    defer { isLoadingMonth = false }

    do {
      let templates = try await CrosswordAPI.shared.fetchCalendarMonth(yearMonth)
      monthTemplates = templates

      switch appModel.homeMode {
      case .local:
        monthSummaries = Dictionary(uniqueKeysWithValues: templates.map { template in
          let summary = SoloStore.shared.loadState(for: template.date)?.summary ?? normalizedSummary(from: template)
          return (template.date, summary)
        })
      case .communal:
        var nextSummaries: [String: PuzzleProgressSummary] = [:]
        try await withThrowingTaskGroup(of: (String, PuzzleProgressSummary).self) { group in
          for template in templates {
            group.addTask {
              do {
                let shared = try await CrosswordAPI.shared.fetchSharedState(template.date)
                return (template.date, communalSummary(template: template, shared: shared))
              } catch {
                return (template.date, normalizedSummary(from: template))
              }
            }
          }
          for try await (date, summary) in group {
            nextSummaries[date] = summary
          }
        }
        monthSummaries = nextSummaries
      }
      if force {
        appModel.errorMessage = nil
      }
    } catch {
      appModel.errorMessage = error.localizedDescription
      if monthTemplates.isEmpty {
        monthSummaries = [:]
      }
    }
  }
}

private struct DayCell: View {
  let dayNumber: String
  let summary: PuzzleProgressSummary?
  let isToday: Bool
  var isLoading = false
  var isDimmed = false

  var body: some View {
    VStack(spacing: 4) {
      HStack {
        Text(dayNumber)
          .font(.caption.weight(.bold))
          .foregroundStyle(isDimmed ? Color.secondary.opacity(0.6) : Color.primary)
        Spacer()
      }
      .padding(.horizontal, 8)
      .padding(.top, 6)

      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(isDimmed ? Color.gray.opacity(0.12) : Color.white)

        if let summary {
          PuzzleThumbnail(summary: summary)
            .padding(6)
        } else if isLoading {
          ProgressView()
            .controlSize(.small)
        }
      }
      .padding(.horizontal, 4)
      .padding(.bottom, 4)
    }
    .frame(height: 86)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(isDimmed ? Color.gray.opacity(0.12) : Color(red: 0.93, green: 0.95, blue: 0.99))
    )
    .overlay(alignment: .topTrailing) {
      if summary?.isComplete == true {
        Image(systemName: "star.fill")
          .font(.caption.weight(.bold))
          .foregroundStyle(.yellow)
          .padding(8)
      }
    }
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .stroke(isToday ? Color.blue : Color.clear, lineWidth: 2)
    )
  }
}

private struct PuzzleThumbnail: View {
  let summary: PuzzleProgressSummary

  var body: some View {
    Canvas { context, size in
      let cellWidth = size.width / CGFloat(summary.cols)
      let cellHeight = size.height / CGFloat(summary.rows)

      for row in 0 ..< summary.rows {
        for col in 0 ..< summary.cols {
          let index = row * summary.cols + col
          let value = summary.cells[index]
          let rect = CGRect(
            x: CGFloat(col) * cellWidth,
            y: CGFloat(row) * cellHeight,
            width: cellWidth,
            height: cellHeight
          )
          let color: Color
          if value == 0 {
            color = .black
          } else if summary.isComplete {
            color = value == 2 ? Color(red: 0.19, green: 0.37, blue: 0.69) : Color(red: 0.35, green: 0.52, blue: 0.84)
          } else if summary.filledCount > 0 {
            color = value == 2 ? Color(red: 0.34, green: 0.62, blue: 0.86) : .white
          } else {
            color = Color.gray.opacity(0.55)
          }
          context.fill(Path(rect), with: .color(color))
        }
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}
