# Fixed helper sent through an SSH exec channel; user paths arrive only as JSON stdin.
import ctypes, errno, json, os, pathlib, shutil, stat, sys, tarfile, tempfile, zipfile

def safe_name(name):
    if not name or len(name)>4096 or "\\" in name or "\x00" in name or "\ufffd" in name:
        raise ValueError("invalid archive name")
    p=pathlib.PurePosixPath(name)
    if p.is_absolute() or any(x in ("..",) or ":" in x for x in p.parts):
        raise ValueError("unsafe archive path")
    name.encode("utf-8", "strict")
    return str(p)

def commit(source, target):
    libc=ctypes.CDLL(None,use_errno=True)
    rename=getattr(libc,"renameat2",None)
    if rename is None: raise ValueError("Linux renameat2 is required")
    rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    rename.restype=ctypes.c_int
    if rename(-100,os.fsencode(source),-100,os.fsencode(target),1)!=0:
        raise OSError(ctypes.get_errno(),"cannot commit archive without overwriting")

def run(request):
    paths=request["paths"]
    if not paths or len(paths)>1000: raise ValueError("select 1-1000 items")
    target=os.path.join(os.path.realpath(os.path.dirname(request["target"])),os.path.basename(request["target"]))
    if os.path.basename(target) in ("", ".", "..") or os.path.lexists(target): raise ValueError("target exists or invalid")
    limit=request.get("limitMb",2048)*1024*1024
    if not 1024*1024<=limit<=16*1024**3: raise ValueError("size limit must be 1-16384 MiB")
    stage=tempfile.mkdtemp(prefix=".daxterm-archive-",dir=os.path.dirname(target))
    os.chmod(stage,0o700)
    total=0
    try:
        if request["operation"]=="compress":
            nodes=[];names=set()
            for root in paths:
                root=os.path.abspath(root)
                if root=="/":raise ValueError("cannot archive root")
                queue=[(root,safe_name(os.path.basename(root)))]
                while queue:
                    path,name=queue.pop();info=os.lstat(path)
                    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):raise ValueError("links and special files are not supported")
                    if name in names:raise ValueError("duplicate source names")
                    names.add(name);nodes.append((path,name,info))
                    total+=info.st_size if stat.S_ISREG(info.st_mode) else 0
                    if len(nodes)>20000 or total>limit:raise ValueError("archive size or item limit exceeded")
                    if stat.S_ISDIR(info.st_mode):
                        if os.path.commonpath([path,stage])==path:raise ValueError("archive target is inside its source")
                        queue.extend((entry.path,safe_name(name+"/"+entry.name)) for entry in os.scandir(path))
            artifact=os.path.join(stage,"archive")
            fmt=request.get("format","zip")
            if fmt=="zip":
                with zipfile.ZipFile(artifact,"x",compression=zipfile.ZIP_DEFLATED,compresslevel=6,strict_timestamps=False) as archive:
                    for path,name,before in nodes:
                        after=os.lstat(path)
                        if (after.st_ino,after.st_mode,after.st_size,after.st_mtime_ns)!=(before.st_ino,before.st_mode,before.st_size,before.st_mtime_ns):raise ValueError("source changed")
                        archive.write(path,name)
            elif fmt in ("tar","tar.gz"):
                with tarfile.open(artifact,"x:gz" if fmt=="tar.gz" else "x:",format=tarfile.PAX_FORMAT,dereference=False) as archive:
                    for path,name,before in nodes:
                        after=os.lstat(path)
                        if (after.st_ino,after.st_mode,after.st_size,after.st_mtime_ns)!=(before.st_ino,before.st_mode,before.st_size,before.st_mtime_ns):raise ValueError("source changed")
                        archive.add(path,arcname=name,recursive=False)
            else:raise ValueError("unsupported compression format")
            os.chmod(artifact,0o600)
            commit(artifact,target)
        elif request["operation"]=="extract":
            if len(paths)!=1:raise ValueError("select one archive")
            artifact=os.path.join(stage,"contents");os.mkdir(artifact,0o700)
            source=paths[0];is_zip=zipfile.is_zipfile(source)
            encoding=request.get("encoding","auto")
            if encoding not in ("auto","cp437","cp949","cp932","gbk","big5"):raise ValueError("unsupported filename encoding")
            if is_zip:
                if encoding!="auto" and sys.version_info<(3,11):raise ValueError("filename encoding requires Python 3.11+")
                archive=zipfile.ZipFile(source,"r",**({"metadata_encoding":encoding} if encoding!="auto" else {}))
                members=archive.infolist()
            else:
                archive=tarfile.open(source,"r:*");members=[]
                for member in archive:
                    members.append(member)
                    if len(members)>20000:raise ValueError("too many archive entries")
            with archive:
                if len(members)>20000:raise ValueError("too many archive entries")
                entries=[];seen=set()
                for member in members:
                    name=safe_name(member.filename if is_zip else member.name)
                    if name==".":continue
                    directory=member.is_dir() if is_zip else member.isdir()
                    size=member.file_size if is_zip else member.size
                    mode=(member.external_attr>>16) if is_zip else member.mode
                    if (is_zip and stat.S_IFMT(mode) not in (0,stat.S_IFDIR,stat.S_IFREG)) or (not is_zip and not (member.isdir() or member.isreg())):
                        raise ValueError("archive links and special entries are rejected")
                    if name in seen:raise ValueError("duplicate archive entry")
                    seen.add(name);total+=size
                    if size<0 or total>limit:raise ValueError("expanded archive exceeds size limit")
                    entries.append((member,name,directory,size,mode))
                written=0;directories=[]
                for member,name,directory,size,mode in entries:
                    path=os.path.join(artifact,*pathlib.PurePosixPath(name).parts)
                    if directory:
                        os.makedirs(path,mode=0o700,exist_ok=True);directories.append((path,mode))
                    else:
                        os.makedirs(os.path.dirname(path),mode=0o700,exist_ok=True)
                        reader=archive.open(member) if is_zip else archive.extractfile(member)
                        count=0
                        with reader,open(path,"xb") as output:
                            while True:
                                chunk=reader.read(65536)
                                if not chunk:break
                                count+=len(chunk);written+=len(chunk)
                                if count>size or written>limit:raise ValueError("expanded archive exceeds size limit")
                                output.write(chunk)
                        if count!=size:raise ValueError("archive member size mismatch")
                        os.chmod(path,(mode&0o777) or 0o600)
                for path,mode in sorted(directories,key=lambda item:len(item[0]),reverse=True):os.chmod(path,(mode&0o777) or 0o700)
            commit(artifact,target)
        else:raise ValueError("unsupported archive operation")
        return {"ok":True,"target":target}
    finally:
        # The only recursive cleanup target is our mkdtemp child, never a request path.
        if os.path.dirname(stage)==os.path.dirname(target) and os.path.basename(stage).startswith(".daxterm-archive-"):
            shutil.rmtree(stage)

try:
    request=json.loads(sys.stdin.buffer.read(1024*1024))
    print(json.dumps(run(request),ensure_ascii=True))
except Exception as error:
    print(json.dumps({"ok":False,"error":str(error)[:1000]},ensure_ascii=True));sys.exit(1)
