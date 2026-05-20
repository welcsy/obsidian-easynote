Feature: Wikilink 解析
  身為 EasyNote 使用者
  我希望文字圖層中的 wikilink 語法能被正確識別與分段
  以便在畫布上點擊後可跳轉到對應的 Obsidian 筆記

  Scenario: 純文字不產生連結段落
    Given 文字內容為 "hello world"
    When 進行 Wikilink 解析
    Then 解析結果共有 1 段
    And 第 1 段不是連結

  Scenario: 單一 wikilink 解析為連結段落
    Given 文字內容為 "[[MyNote]]"
    When 進行 Wikilink 解析
    Then 解析結果共有 1 段
    And 第 1 段是連結
    And 第 1 段的筆記名稱為 "MyNote"
    And 第 1 段的顯示文字為 "MyNote"

  Scenario: 含別名的 wikilink 使用別名作為顯示文字
    Given 文字內容為 "[[ProjectNote|顯示名稱]]"
    When 進行 Wikilink 解析
    Then 第 1 段的顯示文字為 "顯示名稱"
    And 第 1 段的筆記名稱為 "ProjectNote"

  Scenario: wikilink 夾在文字中間產生三個段落
    Given 文字內容為 "前面 [[Note1]] 後面"
    When 進行 Wikilink 解析
    Then 解析結果共有 3 段
    And 第 1 段不是連結
    And 第 2 段是連結
    And 第 2 段的筆記名稱為 "Note1"
    And 第 3 段不是連結

  Scenario: 空字串不產生任何段落
    Given 文字內容為 ""
    When 進行 Wikilink 解析
    Then 解析結果共有 0 段

  Scenario: 單括號不視為 wikilink
    Given 文字內容為 "[NotALink]"
    When 進行 Wikilink 解析
    Then 第 1 段不是連結

  Scenario: 連結名稱前後空白自動 trim
    Given 文字內容為 "[[ SpacedNote ]]"
    When 進行 Wikilink 解析
    Then 第 1 段的筆記名稱為 "SpacedNote"

  Scenario: 連續兩個 wikilink 各自獨立解析
    Given 文字內容為 "[[NoteA]][[NoteB]]"
    When 進行 Wikilink 解析
    Then 解析結果共有 2 段
    And 第 1 段的筆記名稱為 "NoteA"
    And 第 2 段的筆記名稱為 "NoteB"
