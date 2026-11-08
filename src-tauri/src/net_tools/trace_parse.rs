//! Reads traceroute and tracepath output a line at a time. The text comes from a server, so only
//! numbers and addresses are taken from it and nothing else reaches the screen.
use serde::Serialize;
use std::net::IpAddr;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub hop: u8,
    pub address: Option<String>,
    pub rtt_ms: Option<f64>,
    pub reached: bool,
    /// The device said there is no way on (`!H`, `!N`, `!X` and the like).
    pub unreachable: bool,
}

#[derive(Debug, PartialEq)]
pub enum Line {
    /// The address behind the name that was asked for.
    Destination(String),
    Hop(Hop),
    Other,
}

/// The `(address)` in `traceroute to name (address), 30 hops max`.
fn header_address(line: &str) -> Option<String> {
    let inner = line.split_once('(')?.1.split_once(')')?.0;
    inner
        .parse::<IpAddr>()
        .ok()
        .map(|address| address.to_string())
}

pub fn traceroute(line: &str, destination: Option<&str>) -> Line {
    if line.starts_with("traceroute to ") {
        return header_address(line).map_or(Line::Other, Line::Destination);
    }
    let mut tokens = line.split_whitespace().peekable();
    let Some(hop) = tokens.next().and_then(|token| token.parse::<u8>().ok()) else {
        return Line::Other;
    };
    let (mut address, mut rtt_ms, mut unreachable, mut starred) = (None, None, false, false);
    while let Some(token) = tokens.next() {
        if token == "*" {
            starred = true;
        } else if let Ok(found) = token.parse::<IpAddr>() {
            address.get_or_insert_with(|| found.to_string());
        } else if tokens.peek() == Some(&"ms") {
            if let Ok(ms) = token.parse::<f64>() {
                rtt_ms.get_or_insert(ms);
            }
            tokens.next();
        } else if token.starts_with('!') {
            unreachable = true;
        }
    }
    if address.is_none() && !starred {
        return Line::Other;
    }
    let reached = address
        .as_deref()
        .is_some_and(|found| Some(found) == destination);
    Line::Hop(Hop {
        hop,
        address,
        rtt_ms,
        reached,
        unreachable,
    })
}

/// ` 1?: [LOCALHOST]` is the tool's own start, and `Resume:` or `Too many hops` are not hops.
pub fn tracepath(line: &str, destination: Option<&str>) -> Line {
    let mut tokens = line.split_whitespace();
    let Some(hop) = tokens
        .next()
        .and_then(|token| token.strip_suffix(':'))
        .and_then(|token| token.parse::<u8>().ok())
    else {
        return Line::Other;
    };
    let (mut address, mut rtt_ms, mut reached, mut silent) = (None, None, false, false);
    for token in tokens {
        if token == "no" {
            silent = true;
        } else if token == "reached" {
            reached = true;
        } else if let Ok(found) = token.parse::<IpAddr>() {
            address.get_or_insert_with(|| found.to_string());
        } else if let Some(ms) = token
            .strip_suffix("ms")
            .and_then(|ms| ms.parse::<f64>().ok())
        {
            rtt_ms.get_or_insert(ms);
        }
    }
    if address.is_none() && !silent {
        return Line::Other;
    }
    reached |= address.is_some() && address.as_deref() == destination;
    Line::Hop(Hop {
        hop,
        address,
        rtt_ms,
        reached,
        unreachable: false,
    })
}

/// Name failures are worded by each tool, and running another tool would not help.
pub fn is_name_failure(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    [
        "name or service not known",
        "temporary failure in name resolution",
        "unknown host",
        "bad address",
    ]
    .iter()
    .any(|part| line.contains(part))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(line: Line) -> Hop {
        match line {
            Line::Hop(hop) => hop,
            other => panic!("not a hop: {other:?}"),
        }
    }

    #[test]
    fn traceroute_header_gives_the_address_behind_a_name() {
        assert_eq!(
            traceroute(
                "traceroute to db.example (10.0.0.5), 30 hops max, 60 byte packets",
                None
            ),
            Line::Destination("10.0.0.5".into())
        );
        assert_eq!(
            traceroute("traceroute to db.example, 30 hops max", None),
            Line::Other
        );
    }

    #[test]
    fn a_traceroute_hop_takes_its_first_address_and_time() {
        let parsed = hop(traceroute(
            " 1  172.18.0.1  0.055 ms  0.021 ms",
            Some("10.0.0.5"),
        ));
        assert_eq!(parsed.hop, 1);
        assert_eq!(parsed.address.as_deref(), Some("172.18.0.1"));
        assert_eq!(parsed.rtt_ms, Some(0.055));
        assert!(!parsed.reached);
    }

    #[test]
    fn a_lost_probe_does_not_hide_the_other_one() {
        let parsed = hop(traceroute(" 3  *  10.0.0.1  1.1 ms", None));
        assert_eq!(parsed.address.as_deref(), Some("10.0.0.1"));
        let silent = hop(traceroute(" 4  *  *", None));
        assert_eq!(silent.address, None);
        assert_eq!(silent.rtt_ms, None);
    }

    #[test]
    fn reaching_the_destination_and_being_refused_are_told_apart() {
        let reached = hop(traceroute(" 2  10.0.0.5  0.3 ms", Some("10.0.0.5")));
        assert!(reached.reached);
        let refused = hop(traceroute(
            " 2  10.0.0.1  0.3 ms !X  0.2 ms !X",
            Some("10.0.0.5"),
        ));
        assert!(!refused.reached);
        assert!(refused.unreachable);
    }

    #[test]
    fn other_traceroute_lines_are_not_hops() {
        for line in [
            "",
            "socket: Operation not permitted",
            "traceroute: can't connect",
            "1 error occurred",
            "Cannot handle \"host\" cmdline arg `x' on position 1 (argc 3)",
        ] {
            assert_eq!(traceroute(line, None), Line::Other, "{line}");
        }
    }

    #[test]
    fn a_hop_time_that_is_not_a_number_does_not_become_one() {
        let parsed = hop(traceroute(" 2  10.0.0.1  abc ms", None));
        assert_eq!(parsed.rtt_ms, None);
    }

    #[test]
    fn tracepath_lines() {
        assert_eq!(tracepath(" 1?: [LOCALHOST]   pmtu 1500", None), Line::Other);
        let first = hop(tracepath(" 1:  172.18.0.1    0.063ms ", None));
        assert_eq!((first.hop, first.rtt_ms), (1, Some(0.063)));
        let silent = hop(tracepath(" 2:  no reply", None));
        assert_eq!(silent.address, None);
        let last = hop(tracepath(" 3:  10.0.0.5    0.053ms reached", None));
        assert!(last.reached);
        let by_address = hop(tracepath(" 3:  10.0.0.5    0.053ms", Some("10.0.0.5")));
        assert!(by_address.reached);
        assert_eq!(
            tracepath("     Resume: pmtu 1500 hops 2 back 64", None),
            Line::Other
        );
        assert_eq!(
            tracepath("     Too many hops: pmtu 1500", None),
            Line::Other
        );
    }

    #[test]
    fn name_failures_in_each_tools_words() {
        for line in [
            "x: Name or service not known",
            "traceroute: bad address 'x'",
            "tracepath: x: Temporary failure in name resolution",
            "traceroute: unknown host x",
        ] {
            assert!(is_name_failure(line), "{line}");
        }
        assert!(!is_name_failure("socket: Operation not permitted"));
    }
}
