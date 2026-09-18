import smtplib
import getpass
import base64

HOST = "smtp.gmail.com"
PORT = 587

user = input("SMTP user: ").strip()
password = getpass.getpass("Google App Password: ").replace(" ", "")

def connect():
    smtp = smtplib.SMTP(HOST, PORT, timeout=20)
    smtp.ehlo()
    smtp.starttls()
    smtp.ehlo()
    return smtp

print("\nTesting AUTH LOGIN...")
smtp = connect()
try:
    code, _ = smtp.docmd("AUTH", "LOGIN")
    print("AUTH LOGIN:", code)

    code, _ = smtp.docmd(base64.b64encode(user.encode()).decode())
    print("username:", code)

    code, _ = smtp.docmd(base64.b64encode(password.encode()).decode())
    print("password:", code)
finally:
    try:
        smtp.quit()
    except Exception:
        pass

print("\nTesting AUTH PLAIN...")
smtp = connect()
try:
    token = base64.b64encode(
        ("\0" + user + "\0" + password).encode()
    ).decode()

    code, _ = smtp.docmd("AUTH", "PLAIN " + token)
    print("AUTH PLAIN:", code)
finally:
    try:
        smtp.quit()
    except Exception:
        pass