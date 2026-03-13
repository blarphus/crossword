import SwiftUI

@main
struct CrosswordNativeApp: App {
  @StateObject private var appModel = CrosswordAppModel()

  var body: some Scene {
    WindowGroup {
      NavigationStack {
        CalendarScreen()
      }
      .environmentObject(appModel)
      .task {
        await appModel.loadIndex()
      }
    }
  }
}
