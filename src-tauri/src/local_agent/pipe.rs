//! A local tab's named pipe on Windows: the agent's (DX.13) and a WSL tab's Git credential pipe
//! (DX.14). The default pipe security lets every account read it, so each instance gets a DACL
//! naming only the current user, and remote clients are refused.
use std::{ffi::c_void, io, ptr::null_mut};
use tokio::{
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::watch,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

/// The current user's SID, as `S-1-5-…`.
fn user_sid() -> io::Result<String> {
    // SAFETY: every out pointer is a local that outlives its call; the token handle and the
    // string from `ConvertSidToStringSidW` are released below on every path.
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        // `u64` keeps the buffer aligned for `TOKEN_USER`.
        let mut buffer = [0u64; 64];
        let mut length = 0;
        let read = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &mut length,
        );
        CloseHandle(token);
        if read == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(io::Error::last_os_error());
        }
        let length = (0..).take_while(|&i| *text.add(i) != 0).count();
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        Ok(sid)
    }
}

/// Full access for the current user and nobody else, nothing inherited.
pub fn security() -> io::Result<Vec<u16>> {
    Ok(format!("D:P(A;;GA;;;{})", user_sid()?)
        .encode_utf16()
        .chain([0])
        .collect())
}

/// One instance of the pipe `name`. The first one fails if another program already made the name.
pub fn create(name: &str, security: &[u16], first: bool) -> io::Result<NamedPipeServer> {
    // SAFETY: `security` is NUL-terminated (`security()`); the descriptor lives until the pipe is
    // created, which copies it, and is freed right after.
    unsafe {
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            security.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let server = ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                name,
                &mut attributes as *mut SECURITY_ATTRIBUTES as *mut c_void,
            );
        LocalFree(descriptor);
        server
    }
}

/// A pipe with a new random name, `\\.\pipe\dachsterm-<kind>-<32 hex digits>`, and its first
/// instance. The name is the only way in, and it is given to the tab's shell alone.
pub struct Opened {
    pub name: String,
    security: Vec<u16>,
    first: NamedPipeServer,
}
pub fn open(kind: &str) -> io::Result<Opened> {
    let name = format!(
        r"\\.\pipe\dachsterm-{kind}-{}",
        uuid::Uuid::new_v4().simple()
    );
    let security = security()?;
    let first = create(&name, &security, true)?;
    Ok(Opened {
        name,
        security,
        first,
    })
}

/// Hands each connected client to `client` until `stop`. The next instance exists before one is
/// handed over, so the name stays while the tab is open. Once every instance is closed, the pipe
/// is gone.
pub async fn serve(
    opened: Opened,
    mut stop: watch::Receiver<bool>,
    mut client: impl FnMut(NamedPipeServer),
) {
    let Opened {
        name,
        security,
        first: mut server,
    } = opened;
    loop {
        let connected = tokio::select! {
            _ = stop.wait_for(|stopped| *stopped) => return,
            connected = server.connect() => connected,
        };
        let Ok(next) = create(&name, &security, false) else {
            return;
        };
        let accepted = std::mem::replace(&mut server, next);
        if connected.is_ok() {
            client(accepted);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Security::{
        Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT,
        },
        DACL_SECURITY_INFORMATION,
    };

    /// A descriptor's DACL as SDDL. Windows writes well-known SIDs as aliases (`LA`, …).
    unsafe fn text(descriptor: PSECURITY_DESCRIPTOR) -> String {
        // SAFETY (caller): `descriptor` is valid. The string is freed before returning.
        unsafe {
            let mut text = null_mut();
            let mut length = 0;
            assert_ne!(
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    &mut length,
                ),
                0
            );
            let value = String::from_utf16_lossy(std::slice::from_raw_parts(
                text,
                (0..).take_while(|&i| *text.add(i) != 0).count(),
            ));
            LocalFree(text.cast());
            value
        }
    }

    /// The DACL Windows keeps for an open pipe.
    fn dacl(pipe: &NamedPipeServer) -> String {
        // SAFETY: the handle belongs to `pipe`; the descriptor is freed before returning.
        unsafe {
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            assert_eq!(
                GetSecurityInfo(
                    pipe.as_raw_handle(),
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    &mut descriptor,
                ),
                0
            );
            let value = text(descriptor);
            LocalFree(descriptor);
            value
        }
    }

    /// `sddl` the way Windows writes it back.
    fn normal(sddl: &str) -> String {
        let wide: Vec<u16> = sddl.encode_utf16().chain([0]).collect();
        // SAFETY: `wide` is NUL-terminated; the descriptor is freed before returning.
        unsafe {
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                ),
                0
            );
            let value = text(descriptor);
            LocalFree(descriptor);
            value
        }
    }

    #[tokio::test]
    async fn only_the_current_user_may_open_the_pipe() {
        let name = format!(r"\\.\pipe\dachsterm-test-{}", uuid::Uuid::new_v4().simple());
        let security = security().unwrap();
        let sid = user_sid().unwrap();
        assert!(sid.starts_with("S-1-5-"), "{sid}");
        let pipe = create(&name, &security, true).unwrap();
        // GA is stored as the pipe's full access right (FA). No other entry, nothing inherited.
        assert_eq!(dacl(&pipe), normal(&format!("D:P(A;;FA;;;{sid})")));
        assert_eq!(dacl(&pipe).matches("(A;").count(), 1);
        assert!(
            create(&name, &security, true).is_err(),
            "nobody else can take over the name"
        );
        let next = create(&name, &security, false).unwrap();
        tokio::net::windows::named_pipe::ClientOptions::new()
            .open(&name)
            .expect("the same user connects");
        drop((pipe, next));
    }
}
