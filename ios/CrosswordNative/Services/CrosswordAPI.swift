import Foundation

enum APIError: Error, LocalizedError {
  case badResponse
  case invalidURL

  var errorDescription: String? {
    switch self {
    case .badResponse: "The server returned an invalid response."
    case .invalidURL: "The backend URL is invalid."
    }
  }
}

@MainActor
final class CrosswordAPI {
  static let shared = CrosswordAPI()

  let baseURL = URL(string: "https://crossword-8spx.onrender.com")!

  private let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .useDefaultKeys
    return decoder
  }()

  func fetchPuzzleIndex() async throws -> [PuzzleMeta] {
    try await request(path: "/api/puzzles")
  }

  func fetchCalendarMonth(_ yearMonth: String) async throws -> [CalendarTemplate] {
    try await request(path: "/api/calendar/\(yearMonth)")
  }

  func fetchPuzzle(_ date: String) async throws -> PuzzlePayload {
    try await request(path: "/api/puzzles/\(date)")
  }

  func fetchSharedState(_ date: String) async throws -> SharedStatePayload {
    try await request(path: "/api/state/\(date)")
  }

  func updateSharedCell(date: String, row: Int, col: Int, letter: String) async throws {
    struct UpdateCellBody: Encodable {
      let row: Int
      let col: Int
      let letter: String
    }

    var request = try makeRequest(path: "/api/state/\(date)", method: "PUT")
    request.httpBody = try JSONEncoder().encode(UpdateCellBody(row: row, col: col, letter: letter))
    _ = try await URLSession.shared.data(for: request)
  }

  func clearSharedState(_ date: String) async throws {
    let request = try makeRequest(path: "/api/state/\(date)", method: "DELETE")
    _ = try await URLSession.shared.data(for: request)
  }

  private func request<T: Decodable>(path: String) async throws -> T {
    let request = try makeRequest(path: path)
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse, (200 ..< 300).contains(httpResponse.statusCode) else {
      throw APIError.badResponse
    }
    return try decoder.decode(T.self, from: data)
  }

  private func makeRequest(path: String, method: String = "GET") throws -> URLRequest {
    guard let url = URL(string: path, relativeTo: baseURL) else {
      throw APIError.invalidURL
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 20
    if method != "GET" {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }
}
