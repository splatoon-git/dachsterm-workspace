use super::*;

fn search(primary: &[&str], known: &[&str], scanning: bool) -> Search {
    let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect();
    Search {
        primary: list(primary),
        known: list(known),
        scanning,
    }
}

#[test]
fn environment_lines_ignore_rc_noise_and_non_paths() {
    let environment =
        parse_environment("welcome\r\nK=/opt/bin/kubectl\r\nC=/opt/config\nH=/home/x\n");
    assert_eq!(environment.kubectl.as_deref(), Some("/opt/bin/kubectl"));
    assert_eq!(environment.kubeconfig, "/opt/config");
    assert_eq!(environment.home, "/home/x");
    for reported in [
        "K=kubectl",
        "K=alias kubectl='k3s kubectl'",
        "K=",
        "K=/a b/kubectl",
    ] {
        assert_eq!(parse_environment(reported).kubectl, None, "{reported}");
    }
}

#[test]
fn only_the_text_between_the_marks_counts() {
    let text = "\u{1b}[32mhello BEGIN\nK=/k\nEND\nlogout K=/wrong\n";
    assert_eq!(between(text, "BEGIN", "END"), Some("\nK=/k\n"));
    assert_eq!(
        between("BEGIN\nK=/k\n", "BEGIN", "END"),
        None,
        "an rc `exit` cuts the end mark"
    );
    assert_eq!(between("nothing", "BEGIN", "END"), None);
}

#[test]
fn the_login_probe_closes_stdin_and_drops_stderr() {
    let script = login_script("B", "E");
    assert!(script.contains("-lic"), "{script}");
    assert!(script.ends_with("</dev/null 2>/dev/null"), "{script}");
    assert!(
        script.starts_with("s=${SHELL:-/bin/sh}; \"$s\" -lic '"),
        "{script}"
    );
}

#[test]
fn access_lines_are_matched_by_the_whole_path() {
    let text = "R /a b\nU /etc/rke2.yaml\r\nN /none\n";
    assert_eq!(parse_access(text, "/a b"), Access::Readable);
    assert_eq!(parse_access(text, "/etc/rke2.yaml"), Access::Unreadable);
    assert_eq!(parse_access(text, "/none"), Access::Missing);
    assert_eq!(parse_access(text, "/a"), Access::Missing);
}

#[test]
fn the_access_script_quotes_paths() {
    let script = access_script(&["/a'b".to_string(), "/$(id)".to_string()]);
    assert!(script.contains("c '/a'\\''b'"), "{script}");
    assert!(script.contains("c '/$(id)'"), "{script}");
}

#[test]
fn a_scan_prefers_the_environment_then_the_known_order() {
    let s = search(
        &["/env"],
        &["/home/x/.kube/dachsterm.config", "/home/x/.kube/config"],
        true,
    );
    let got = choose(&s, "R /env\nR /home/x/.kube/config\n");
    assert_eq!(
        (got.state, got.kubeconfig.as_str()),
        (KubeState::Ready, "/env")
    );
    let got = choose(&s, "N /env\nR /home/x/.kube/config\n");
    assert_eq!(got.kubeconfig, "/home/x/.kube/config");
}

#[test]
fn a_private_copy_wins_while_kubeconfig_still_points_at_the_root_only_file() {
    let s = search(
        &["/etc/rke2.yaml"],
        &["/home/x/.kube/dachsterm.config"],
        true,
    );
    let got = choose(&s, "U /etc/rke2.yaml\nR /home/x/.kube/dachsterm.config\n");
    assert_eq!(
        (got.state, got.kubeconfig.as_str()),
        (KubeState::Ready, "/home/x/.kube/dachsterm.config")
    );
}

#[test]
fn nothing_readable_reports_unreadable_before_missing() {
    let s = search(&[], &["/a", "/b"], true);
    let got = choose(&s, "N /a\nU /b\n");
    assert_eq!(
        (got.state, got.kubeconfig.as_str()),
        (KubeState::ConfigUnreadable, "/b")
    );
    let got = choose(&s, "N /a\nN /b\n");
    assert_eq!(got.state, KubeState::ConfigMissing);
}

#[test]
fn a_stored_or_typed_path_does_not_fall_back_to_other_files() {
    let s = search(&["/saved"], &["/other"], false);
    let got = choose(&s, "N /saved\nR /other\n");
    assert_eq!(
        (got.state, got.kubeconfig.as_str()),
        (KubeState::ConfigMissing, "/saved")
    );
}

#[test]
fn only_readable_entries_of_a_list_are_kept() {
    let s = search(&["/a", "/b", "/c"], &[], true);
    let got = choose(&s, "R /a\nU /b\nR /c\n");
    assert_eq!(got.kubeconfig, "/a:/c");
}

#[test]
fn the_copy_comes_from_a_root_only_original_never_the_old_copy() {
    let s = search(
        &["/home/x/.kube/dachsterm.config"],
        &["/etc/rancher/rke2/rke2.yaml"],
        false,
    );
    let source = copy_source(
        &s,
        "R /home/x/.kube/dachsterm.config\nU /etc/rancher/rke2/rke2.yaml\n",
    );
    assert_eq!(source.as_deref(), Some("/etc/rancher/rke2/rke2.yaml"));
    let s = search(&["/home/x/.kube/dachsterm.config"], &[], false);
    assert_eq!(copy_source(&s, "U /home/x/.kube/dachsterm.config\n"), None);
}

#[test]
fn the_copy_command_is_the_measured_one_and_quotes_its_source() {
    assert_eq!(
        copy_command("/etc/rancher/rke2/rke2.yaml"),
        "mkdir -p ~/.kube && sudo install -m 600 -o \"$(id -u)\" -g \"$(id -g)\" '/etc/rancher/rke2/rke2.yaml' ~/.kube/dachsterm.config"
    );
    assert!(copy_command("/a'b; reboot").contains("'/a'\\''b; reboot'"));
}

#[test]
fn known_paths_need_a_usable_home() {
    let found = known_paths("/home/x");
    assert_eq!(found[0], "/home/x/.kube/dachsterm.config");
    assert_eq!(found[1], "/home/x/.kube/config");
    assert_eq!(found[2], "/etc/rancher/rke2/rke2.yaml");
    assert_eq!(found[4], "/etc/kubernetes/admin.conf");
    assert_eq!(known_paths("").len(), 3, "no home means no ~ paths");
}

#[test]
fn a_config_list_keeps_absolute_entries() {
    assert_eq!(split_config("/a:relative::/b"), ["/a", "/b"]);
    assert!(split_config("").is_empty());
}

#[test]
fn names_are_checked_stripped_and_capped() {
    let got = names(
        "namespace/default\nnamespace/Bad_Name\n\nnamespace/kube-system\r\n",
        check_namespace,
        "namespace/",
    );
    assert_eq!(got, ["default", "kube-system"]);
    let many = "a\n".repeat(MAX_NAMES + 10);
    assert_eq!(names(&many, check_context, "").len(), MAX_NAMES);
}

#[test]
fn a_context_is_only_taken_if_it_exists() {
    let contexts = ["a".to_string(), "b".to_string()];
    assert_eq!(
        chosen_context(None, &contexts, Some("b")).as_deref(),
        Some("b")
    );
    assert_eq!(
        chosen_context(None, &contexts, Some("gone")).as_deref(),
        Some("a")
    );
    assert_eq!(chosen_context(None, &contexts, None).as_deref(), Some("a"));
    assert_eq!(
        chosen_context(Some("b"), &contexts, Some("a")).as_deref(),
        Some("b")
    );
    assert_eq!(chosen_context(Some("gone"), &contexts, Some("a")), None);
    assert_eq!(chosen_context(None, &[], None), None);
}
