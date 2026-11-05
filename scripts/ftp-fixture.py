import datetime,ipaddress,json,logging,os,pathlib,sys
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler,TLS_FTPHandler,ThrottledDTPHandler
from pyftpdlib.servers import FTPServer
from pyftpdlib.ioloop import IOLoop
logging.disable(logging.CRITICAL)
root=pathlib.Path(os.environ['DAXTERM_FTP_ROOT'])
key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'DaxTerm temporary test CA')])
now=datetime.datetime.now(datetime.timezone.utc)
ca=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=5)).not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True,path_length=None),True).sign(key,hashes.SHA256())
server_key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
server_name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
cert=x509.CertificateBuilder().subject_name(server_name).issuer_name(name).public_key(server_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=5)).not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),False).add_extension(x509.BasicConstraints(ca=False,path_length=None),True).sign(key,hashes.SHA256())
(root/'ca.pem').write_bytes(ca.public_bytes(serialization.Encoding.PEM))
(root/'server.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
(root/'server.key').write_bytes(server_key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
home=root/'home';home.mkdir(exist_ok=True)
authorizer=DummyAuthorizer();authorizer.add_user('fixture',os.environ['DAXTERM_FTP_PASSWORD'],str(home),perm='elradfmwMT')
servers=[];ports={}
for protocol,encoding in [('ftp','utf-8'),('ftps','utf-8'),('legacy','cp949')]:
    base=TLS_FTPHandler if protocol=='ftps' else FTPHandler
    handler=type('FixtureHandler',(base,),{'authorizer':authorizer,'encoding':encoding,'use_sendfile':False,'banner':'DaxTerm FTP fixture'})
    if protocol=='ftps':
        handler.certfile=str(root/'server.pem');handler.keyfile=str(root/'server.key');handler.tls_control_required=True;handler.tls_data_required=True
    server=FTPServer(('127.0.0.1',0),handler);server.max_cons=64;servers.append(server);ports[protocol]=server.socket.getsockname()[1]
print(json.dumps({'ports':ports,'ca':str(root/'ca.pem')}),flush=True)
IOLoop.instance().loop()
