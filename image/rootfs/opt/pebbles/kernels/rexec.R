# Persistent R cell executor (mirror of pyexec.py).
#
# Spawned lazily by sql-runner as the SESSION USER and kept alive for the session:
# the environment persists across cells. Protocol: one JSON request line in
# ({"code": ...}), one JSON response line out ({"ok","stdout","stderr","error"}).
# Visible results print, notebook-style. jsonlite ships with r-essentials (REQ-52).

suppressMessages(library(jsonlite))

cell_env <- new.env(parent = globalenv())
stdin_con <- file("stdin", open = "r")

respond <- function(ok, stdout, error, images = list(), table = NULL) {
  cat(toJSON(
    list(ok = ok, stdout = stdout, stderr = "", error = error,
         images = images, table = table),
    auto_unbox = TRUE, null = "null", na = "null", dataframe = "rows"
  ))
  cat("\n")
  flush(stdout())
}

# A data frame as {columns, rows, total} (data, not HTML) — first 200 rows.
as_table <- function(v) {
  if (!is.data.frame(v)) return(NULL)
  head_df <- utils::head(as.data.frame(v), 200)
  list(columns = names(head_df), rows = head_df, total = nrow(v),
       truncated = nrow(v) > 200)
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
  table <- NULL
  # Plots (base graphics and ggplot) render to a per-cell PNG device.
  plot_dir <- tempfile("cellplots")
  dir.create(plot_dir)
  grDevices::png(file.path(plot_dir, "p%03d.png"), width = 800, height = 500, res = 100)
  out_file <- textConnection("captured", open = "w", local = TRUE)
  sink(out_file)
  sink(out_file, type = "message")
  tryCatch(
    {
      exprs <- parse(text = req$code)
      for (i in seq_along(exprs)) {
        res <- withVisible(eval(exprs[[i]], envir = cell_env))
        if (res$visible && i == length(exprs)) {
          table <- as_table(res$value)
          if (is.null(table)) print(res$value)
        }
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
  invisible(grDevices::dev.off())
  images <- list()
  for (f in utils::head(sort(list.files(plot_dir, full.names = TRUE)), 8)) {
    if (file.info(f)$size > 0 && file.info(f)$size <= 2e6) {
      images[[length(images) + 1]] <- base64_enc(readBin(f, "raw", file.info(f)$size))
    }
  }
  unlink(plot_dir, recursive = TRUE)

  stdout_text <- if (exists("captured")) paste(captured, collapse = "\n") else ""
  if (nchar(stdout_text) > 0) stdout_text <- paste0(stdout_text, "\n")
  respond(ok, stdout_text, err, images, table)
}
