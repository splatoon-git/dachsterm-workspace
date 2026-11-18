//! Reads keys under `HKEY_CURRENT_USER` for the import from this PC (I.2). Read-only: nothing here
//! writes the registry, and the values are only handed to the inert import parsers.
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    Foundation::ERROR_SUCCESS,
    System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, REG_DWORD, REG_EXPAND_SZ, REG_SZ, RegCloseKey,
        RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW,
    },
};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

/// An open key, closed when dropped.
pub(super) struct Key(HKEY);

impl Key {
    /// `path` under `HKEY_CURRENT_USER`. `None`: the key does not exist or cannot be read.
    pub(super) fn open(path: &str) -> Option<Key> {
        Self::open_in(HKEY_CURRENT_USER, path)
    }
    fn open_in(parent: HKEY, path: &str) -> Option<Key> {
        let mut key: HKEY = null_mut();
        let path = wide(path);
        // SAFETY: `path` is NUL-terminated and outlives the call; `key` is written on success.
        let status = unsafe { RegOpenKeyExW(parent, path.as_ptr(), 0, KEY_READ, &mut key) };
        (status == ERROR_SUCCESS).then_some(Key(key))
    }
    pub(super) fn child(&self, name: &str) -> Option<Key> {
        Self::open_in(self.0, name)
    }
    /// The names of the direct subkeys. A name longer than the registry's 255 characters cannot
    /// exist, so the fixed buffer is enough.
    pub(super) fn children(&self) -> Vec<String> {
        let mut names = Vec::new();
        let mut buffer = [0u16; 256];
        for index in 0.. {
            let mut length = buffer.len() as u32;
            // SAFETY: `buffer` holds `length` characters; the other out-parameters are optional.
            let status = unsafe {
                RegEnumKeyExW(
                    self.0,
                    index,
                    buffer.as_mut_ptr(),
                    &mut length,
                    null(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            names.push(String::from_utf16_lossy(&buffer[..length as usize]));
        }
        names
    }
    /// A text value as written, or a DWORD in decimal. `None`: missing or of another type.
    pub(super) fn value(&self, name: &str) -> Option<String> {
        let name = wide(name);
        let (mut kind, mut size) = (0u32, 0u32);
        // SAFETY: a null data pointer asks only for the type and the size in bytes.
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                name.as_ptr(),
                null(),
                &mut kind,
                null_mut(),
                &mut size,
            )
        };
        // Import fields are short; a huge value is not one of them.
        if status != ERROR_SUCCESS || size > 64 * 1024 {
            return None;
        }
        let mut data = vec![0u16; (size as usize).div_ceil(2)];
        // SAFETY: `data` holds at least `size` bytes.
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                name.as_ptr(),
                null(),
                &mut kind,
                data.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let data = &data[..(size as usize / 2).min(data.len())];
        match kind {
            REG_SZ | REG_EXPAND_SZ => {
                let end = data.iter().position(|&c| c == 0).unwrap_or(data.len());
                String::from_utf16(&data[..end]).ok()
            }
            REG_DWORD if data.len() >= 2 => {
                Some((u32::from(data[0]) | u32::from(data[1]) << 16).to_string())
            }
            _ => None,
        }
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: the key was opened by `open_in` and is closed once.
        unsafe { RegCloseKey(self.0) };
    }
}

/// Writes a throwaway key for the tests, removed again by `remove_tree`.
#[cfg(test)]
pub(super) mod fixture {
    use super::wide;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
        RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW,
    };

    pub enum Value<'a> {
        Text(&'a str),
        Number(u32),
    }

    pub fn write(path: &str, values: &[(&str, Value)]) {
        let mut key: HKEY = null_mut();
        let path = wide(path);
        // SAFETY: test-only calls with NUL-terminated names and buffers that outlive each call.
        unsafe {
            assert_eq!(
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    0,
                    null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_WRITE,
                    null(),
                    &mut key,
                    null_mut(),
                ),
                0
            );
            for (name, value) in values {
                let name = wide(name);
                let (kind, bytes) = match value {
                    Value::Text(text) => (
                        REG_SZ,
                        wide(text).iter().flat_map(|c| c.to_le_bytes()).collect(),
                    ),
                    Value::Number(n) => (REG_DWORD, n.to_le_bytes().to_vec()),
                };
                RegSetValueExW(
                    key,
                    name.as_ptr(),
                    0,
                    kind,
                    bytes.as_ptr(),
                    bytes.len() as u32,
                );
            }
            RegCloseKey(key);
        }
    }

    pub fn remove_tree(path: &str) {
        let path = wide(path);
        // SAFETY: test-only; removes the throwaway key this module created.
        unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, path.as_ptr()) };
    }
}
