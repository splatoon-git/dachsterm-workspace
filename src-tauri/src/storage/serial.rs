//! Serial console settings (CG.5). The device name sits in the profile's `host`, so the session
//! list, search and sort treat it like any other session.
use super::{Profile, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialSettings {
    pub baud: u32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: u8,
    pub flow: Flow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Flow {
    None,
    /// XON/XOFF.
    Software,
    /// RTS/CTS.
    Hardware,
}

/// A device name as Windows (`COM3`) or macOS (`/dev/cu.usbserial-1410`) writes it. Either is
/// saved on either system: a session file from the other PC keeps its name, and connecting says
/// the device is not here (`serial::open`).
pub(crate) fn device_name(name: &str) -> bool {
    if let Some(number) = name.strip_prefix("COM") {
        return number.parse::<u16>().is_ok_and(|n| (1..=255).contains(&n))
            && number.chars().all(|c| c.is_ascii_digit());
    }
    name.strip_prefix("/dev/cu.").is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 128
            && !rest.contains("..")
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    })
}

/// The name this system opens, which the port list also shows.
pub(crate) fn native_device(name: &str) -> bool {
    device_name(name) && name.starts_with("COM") == cfg!(windows)
}

impl Profile {
    /// Telnet and serial carry a terminal only, and the user logs in inside it.
    pub(crate) fn terminal_only(&self) -> bool {
        matches!(self.protocol.as_str(), "telnet" | "serial")
    }

    pub(super) fn check_serial(&self) -> Result<()> {
        if self.protocol != "serial" {
            return match self.serial {
                Some(_) => Err("통신 설정은 시리얼 세션에서만 쓸 수 있습니다.".into()),
                None => Ok(()),
            };
        }
        let s = self.serial.as_ref().ok_or("시리얼 통신 설정이 없습니다.")?;
        if !(50..=4_000_000).contains(&s.baud)
            || !(5..=8).contains(&s.data_bits)
            || !matches!(s.stop_bits, 1 | 2)
        {
            return Err(
                "통신 속도는 50~4,000,000, 데이터 비트는 5~8, 정지 비트는 1·2입니다.".into(),
            );
        }
        if !device_name(&self.host) {
            return Err("장치는 COM3이나 /dev/cu.usbserial-1410처럼 입력하세요.".into());
        }
        if !self.jump_ids.is_empty() || self.proxy.is_some() {
            return Err("시리얼 세션에는 경유지나 프록시를 쓸 수 없습니다.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_names_of_both_systems_are_saved_and_nothing_else() {
        for ok in [
            "COM1",
            "COM255",
            "/dev/cu.usbserial-1410",
            "/dev/cu.SLAB_USBtoUART",
        ] {
            assert!(device_name(ok), "{ok}");
        }
        for bad in [
            "COM0",
            "COM256",
            "COM",
            "com3",
            "COM+3",
            "/dev/tty.usbserial",
            "/dev/cu.",
            "/dev/cu.a/b",
            "/dev/cu...",
            "/etc/passwd",
            "host.example",
        ] {
            assert!(!device_name(bad), "{bad}");
        }
        assert_eq!(native_device("COM3"), cfg!(windows));
        assert_eq!(native_device("/dev/cu.usbserial"), !cfg!(windows));
    }

    #[test]
    fn a_serial_session_needs_its_line_settings_and_nothing_of_a_network() {
        let mut p = Profile::imported("console", "/dev/cu.usbserial-1410", "", 0);
        p.protocol = "serial".into();
        p.auth = "interactive".into();
        assert!(p.validate().unwrap_err().contains("통신 설정"));
        let line = SerialSettings {
            baud: 9600,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: 1,
            flow: Flow::None,
        };
        p.serial = Some(line.clone());
        p.validate().unwrap();
        for bad in [
            SerialSettings {
                baud: 10,
                ..line.clone()
            },
            SerialSettings {
                data_bits: 9,
                ..line.clone()
            },
            SerialSettings {
                stop_bits: 3,
                ..line.clone()
            },
        ] {
            p.serial = Some(bad);
            assert!(p.validate().is_err());
        }
        p.serial = Some(line.clone());
        p.auth = "password".into();
        assert!(p.validate().is_err());
        p.auth = "interactive".into();
        p.host = "router.example".into();
        assert!(p.validate().is_err());
        let mut ssh = Profile::imported("server", "server.example", "user", 22);
        ssh.serial = Some(line);
        assert!(ssh.validate().unwrap_err().contains("시리얼 세션에서만"));
    }
}
