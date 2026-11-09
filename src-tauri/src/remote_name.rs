//! The name a local file gets on the server.
//!
//! macOS can hand back Korean file names as separated jamo (NFD). Servers compare names as bytes,
//! so such a name looks broken to other tools there and has no CP949 form on legacy FTP servers.
//! Only the name sent to the server changes: the local path keeps the bytes the OS returned.
//!
//! A server may already hold the same name in NFD. The two are still different files there, so an
//! upload does not treat them as a conflict and never overwrites a name it did not write.

use crate::{storage::Result, transfer_queue::component};
use icu_normalizer::ComposingNormalizerBorrowed;
use std::collections::HashSet;

/// Normalizes a local name to NFC and rejects names that are unsafe on the server.
pub fn upload_name(local: &str) -> Result<String> {
    let name = ComposingNormalizerBorrowed::new_nfc()
        .normalize(local)
        .into_owned();
    component(&name)?;
    Ok(name)
}

/// Sorted pairs of each child's name at the source and at the destination.
///
/// Normalizing can give two local names the same remote name on file systems that keep both forms.
/// A folder like that is refused, because the second file would land on the first.
pub fn child_names(upload: bool, mut names: Vec<String>) -> Result<Vec<(String, String)>> {
    names.sort();
    let mut seen = HashSet::new();
    names
        .into_iter()
        .map(|name| {
            component(&name)?;
            if !upload {
                return Ok((name.clone(), name));
            }
            let sent = upload_name(&name)?;
            if !seen.insert(sent.clone()) {
                return Err(format!(
                    "서버에서 같은 이름이 되는 항목이 한 폴더에 있습니다: {sent}"
                ));
            }
            Ok((name, sent))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NFD: &str = "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}.txt";
    const NFC: &str = "\u{d55c}\u{ae00}.txt";

    #[test]
    fn upload_name_composes_macos_jamo() {
        assert_eq!(upload_name(NFD).unwrap(), NFC);
        assert_eq!(upload_name(NFC).unwrap(), NFC);
        assert_eq!(upload_name("cafe\u{301}.txt").unwrap(), "caf\u{e9}.txt");
    }

    #[test]
    fn upload_name_rejects_unsafe_names() {
        assert!(upload_name("../x").is_err());
        assert!(upload_name("").is_err());
    }

    #[test]
    fn upload_children_keep_the_local_name_for_reading() {
        let names = child_names(true, vec![NFD.into(), "a.txt".into()]).unwrap();
        assert!(names.contains(&(NFD.to_string(), NFC.to_string())));
        assert!(names.contains(&("a.txt".to_string(), "a.txt".to_string())));
    }

    #[test]
    fn downloads_keep_the_server_name() {
        let names = child_names(false, vec![NFD.into()]).unwrap();
        assert_eq!(names, vec![(NFD.to_string(), NFD.to_string())]);
    }

    #[test]
    fn upload_refuses_names_that_collapse_together() {
        let error = child_names(true, vec![NFD.into(), NFC.into()]).unwrap_err();
        assert!(error.contains(NFC), "{error}");
    }

    #[test]
    fn download_allows_both_forms_on_the_server() {
        assert_eq!(
            child_names(false, vec![NFD.into(), NFC.into()])
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn children_are_sorted_by_source_name() {
        let names = child_names(false, vec!["b".into(), "a".into()]).unwrap();
        assert_eq!(names[0].0, "a");
        assert_eq!(names[1].0, "b");
    }
}
