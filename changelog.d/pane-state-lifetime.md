### Fixed
- A pane's message draft, terminal input line, held input and chosen lens no longer show up in a
  different pane after herdr restarts and reuses its pane IDs: they are kept per herdr lifetime,
  which a bridge restart keeps. Earlier text is never put back by itself; the pane's menu has
  **Recover unsent text** to copy it into a box of your choice or discard it.
