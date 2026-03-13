import SwiftUI
import UIKit

struct KeyCaptureField: UIViewRepresentable {
  final class BackspaceTextField: UITextField {
    var onDeleteBackward: (() -> Void)?

    override func deleteBackward() {
      onDeleteBackward?()
      super.deleteBackward()
    }
  }

  final class Coordinator: NSObject, UITextFieldDelegate {
    let parent: KeyCaptureField

    init(parent: KeyCaptureField) {
      self.parent = parent
    }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
      if string.isEmpty {
        parent.onBackspace()
      } else {
        for scalar in string.uppercased().unicodeScalars where CharacterSet.letters.contains(scalar) {
          parent.onInsert(String(scalar))
        }
      }
      textField.text = ""
      return false
    }
  }

  let isFirstResponder: Bool
  let onInsert: (String) -> Void
  let onBackspace: () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(parent: self)
  }

  func makeUIView(context: Context) -> BackspaceTextField {
    let textField = BackspaceTextField(frame: .zero)
    textField.autocapitalizationType = .allCharacters
    textField.autocorrectionType = .no
    textField.spellCheckingType = .no
    textField.keyboardType = .alphabet
    textField.textContentType = .none
    textField.delegate = context.coordinator
    textField.tintColor = .clear
    textField.textColor = .clear
    textField.backgroundColor = .clear
    textField.onDeleteBackward = onBackspace
    return textField
  }

  func updateUIView(_ uiView: BackspaceTextField, context: Context) {
    uiView.onDeleteBackward = onBackspace
    if isFirstResponder, !uiView.isFirstResponder {
      uiView.becomeFirstResponder()
    } else if !isFirstResponder, uiView.isFirstResponder {
      uiView.resignFirstResponder()
    }
  }
}
