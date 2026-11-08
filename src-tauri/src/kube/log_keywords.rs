//! Keywords of a log search: spaces are AND, `!word` excludes, case is ignored. Each word only ever
//! reaches the server as one quoted argument after `--`, so it cannot become shell code or an option.
use crate::{remote_exec::quote, storage::Result};

const MAX_WORDS: usize = 16;
const MAX_WORD_BYTES: usize = 256;

#[derive(Debug, Default, PartialEq)]
pub struct Keywords {
    include: Vec<String>,
    exclude: Vec<String>,
}

/// A timestamp is made of these. Words that are only these could match the timestamp kubectl puts
/// in front of every line instead of the log text.
fn timestamp_like(word: &str) -> bool {
    word.chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | '.' | '+' | 't' | 'T' | 'z' | 'Z'))
}

impl Keywords {
    /// An empty query is allowed here: following a log without a filter has no keywords.
    pub fn parse(query: &str) -> Result<Self> {
        let mut keywords = Self::default();
        for word in query.split_whitespace() {
            if word.len() > MAX_WORD_BYTES || word.chars().any(char::is_control) {
                return Err("검색어가 너무 길거나 사용할 수 없는 문자가 있습니다.".into());
            }
            match word.strip_prefix('!') {
                Some("") => {}
                Some(rest) => keywords.exclude.push(rest.to_string()),
                None => keywords.include.push(word.to_string()),
            }
        }
        if keywords.include.len() + keywords.exclude.len() > MAX_WORDS {
            return Err(format!("검색어는 {MAX_WORDS}개까지 넣을 수 있습니다."));
        }
        Ok(keywords)
    }

    pub fn is_empty(&self) -> bool {
        self.include.is_empty() && self.exclude.is_empty()
    }

    /// `| grep` stages to put after kubectl. With `timestamped` output a word that only looks like
    /// a time is not excluded on the server, where it could drop a line for its timestamp alone;
    /// `matches` applies it to the log text afterwards.
    pub fn stages(&self, options: &str, timestamped: bool) -> String {
        let stage =
            |flags: &str, word: &str| format!(" | grep {options}-{flags} -- {}", quote(word));
        self.include
            .iter()
            .map(|word| stage("aiF", word))
            .chain(
                self.exclude
                    .iter()
                    .filter(|word| !(timestamped && timestamp_like(word)))
                    .map(|word| stage("aivF", word)),
            )
            .collect()
    }

    /// The final say on one log line, without its timestamp. grep has seen the timestamp too.
    pub fn matches(&self, text: &str) -> bool {
        let text = text.to_lowercase();
        self.include
            .iter()
            .all(|word| text.contains(&word.to_lowercase()))
            && !self
                .exclude
                .iter()
                .any(|word| text.contains(&word.to_lowercase()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spaces_are_and_and_a_bang_excludes() {
        let keywords = Keywords::parse("Error  !debug timeout !").unwrap();
        assert_eq!(keywords.include, ["Error", "timeout"]);
        assert_eq!(keywords.exclude, ["debug"]);
        assert!(keywords.matches("ERROR: request TIMEOUT"));
        assert!(!keywords.matches("error timeout debug"));
        assert!(!keywords.matches("error only"));
    }

    #[test]
    fn a_keyword_is_one_quoted_argument_after_the_double_dash() {
        let stages = Keywords::parse("$(reboot) a'b -v")
            .unwrap()
            .stages("", false);
        assert_eq!(
            stages,
            " | grep -aiF -- '$(reboot)' | grep -aiF -- 'a'\\''b' | grep -aiF -- '-v'"
        );
    }

    #[test]
    fn an_exclusion_that_could_match_a_timestamp_stays_off_the_server() {
        let keywords = Keywords::parse("error !200 !debug").unwrap();
        let stages = keywords.stages("", true);
        assert!(stages.contains("-aivF -- 'debug'"), "{stages}");
        assert!(!stages.contains("'200'"), "{stages}");
        assert!(!keywords.matches("error 200 ok"));
        assert!(keywords.stages("", false).contains("-aivF -- '200'"));
    }

    #[test]
    fn following_passes_its_grep_option_through() {
        let stages = Keywords::parse("a")
            .unwrap()
            .stages("--line-buffered ", false);
        assert_eq!(stages, " | grep --line-buffered -aiF -- 'a'");
    }

    #[test]
    fn too_much_is_refused() {
        assert!(Keywords::parse(&"x".repeat(MAX_WORD_BYTES + 1)).is_err());
        assert!(Keywords::parse(&"a ".repeat(MAX_WORDS + 1)).is_err());
        assert!(Keywords::parse("a\u{7}b").is_err());
        assert!(Keywords::parse("   ").unwrap().is_empty());
    }
}
