//! Parses Kubernetes resource quantities into the units the screens use.

fn scaled(number: &str, unit: f64) -> Option<u64> {
    let value: f64 = number.parse().ok()?;
    // Rounded first, so `128974848000m` does not come out one byte high from binary fractions.
    (value.is_finite() && value >= 0.0).then(|| ((value * unit * 1e3).round() / 1e3).ceil() as u64)
}

/// A CPU quantity in millicores: `250m`, `2`, `1.5`, `31415926n`.
pub fn cpu_millis(value: &str) -> Option<u64> {
    const SUFFIXES: [(&str, f64); 4] = [("n", 1e-6), ("u", 1e-3), ("m", 1.0), ("k", 1e6)];
    SUFFIXES
        .iter()
        .find_map(|(suffix, unit)| Some((value.strip_suffix(suffix)?, *unit)))
        .map_or_else(
            || scaled(value, 1000.0),
            |(number, unit)| scaled(number, unit),
        )
}

/// A memory quantity in bytes: `64Mi`, `1G`, `129M`, `128974848000m`, `1e3`.
pub fn memory_bytes(value: &str) -> Option<u64> {
    const BINARY: [(&str, f64); 6] = [
        ("Ki", 1024.0),
        ("Mi", 1_048_576.0),
        ("Gi", 1_073_741_824.0),
        ("Ti", 1_099_511_627_776.0),
        ("Pi", 1_125_899_906_842_624.0),
        ("Ei", 1_152_921_504_606_846_976.0),
    ];
    const DECIMAL: [(&str, f64); 7] = [
        ("m", 1e-3),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
        ("E", 1e18),
    ];
    BINARY
        .iter()
        .chain(DECIMAL.iter())
        .find_map(|(suffix, unit)| Some((value.strip_suffix(suffix)?, *unit)))
        .map_or_else(|| scaled(value, 1.0), |(number, unit)| scaled(number, unit))
}
