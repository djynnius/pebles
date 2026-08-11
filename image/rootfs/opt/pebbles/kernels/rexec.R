# Persistent R cell executor (mirror of pyexec.py).
#
# Spawned lazily by sql-runner as the SESSION USER and kept alive for the session:
# the environment persists across cells. Protocol: one JSON request line in
# ({"code": ...}), one JSON response line out ({"ok","stdout","stderr","error"}).
# Visible results print, notebook-style. jsonlite ships with r-essentials (REQ-52).

suppressMessages(library(jsonlite))

cell_env <- new.env(parent = globalenv())
stdin_con <- file("stdin", open = "r")

respond <- function(ok, stdout, error) {
  cat(toJSON(
    list(ok = ok, stdout = stdout, stderr = "", error = error),
    auto_unbox = TRUE, null = "null"
  ))
  cat("\n")
  flush(stdout())
}

while (TRUE) {
  line <- readLines(stdin_con, n = 1)
  if (length(line) == 0) break
  if (nchar(trimws(line)) == 0) next

  req <- tryCatch(fromJSON(line), error = function(e) NULL)
  if (is.null(req) || is.null(req$code)) {
    respond(FALSE, "", "bad request")
    next
  }

  ok <- TRUE
  err <- NULL
  out_file <- textConnection("captured", open = "w", local = TRUE)
  sink(out_file)
  sink(out_file, type = "message")
  tryCatch(
    {
      exprs <- parse(text = req$code)
      for (i in seq_along(exprs)) {
        res <- withVisible(eval(exprs[[i]], envir = cell_env))
        if (res$visible && i == length(exprs)) print(res$value)
      }
    },
    error = function(e) {
      ok <<- FALSE
      err <<- conditionMessage(e)
    }
  )
  sink(type = "message")
  sink()
  close(out_file)

  stdout_text <- if (exists("captured")) paste(captured, collapse = "\n") else ""
  if (nchar(stdout_text) > 0) stdout_text <- paste0(stdout_text, "\n")
  respond(ok, stdout_text, err)
}
