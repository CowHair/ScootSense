import os
import psycopg as phsyco
from dotenv import load_dotenv
from flask import Flask
from flask import request
from supabase import create_client
from session_auth import require_session
from flask import g

load_dotenv()
app = Flask(__name__)


@app.post("/spots")
def add_spot():
    data = request.get_json()
    coord = data.get("coord")
    type = data.get("type")
    if not isinstance(coord, list):
        return {"error": "bad data!"}, 400

    try:
        if len(coord) != 3:
            return {"error": "bad data!"}, 400
        for n in coord:
            if not isinstance(n, int):
                return {"error": "bad data!"}, 400

    except Exception as e:
        return {"Error": str(e)}

    with phsyco.connect(os.environ["CONNECTION"]) as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                           UPDATE public.spots
                           SET count = count + 1
                           WHERE SQRT(
                               POWER(coord[1] - %s, 2) +
                               POWER(coord[2] - %s, 2) +
                               POWER(coord[3] - %s, 2)
                           ) <= %s
                           RETURNING count
                           """,
                (coord[0], coord[1], coord[2], 5),
            )

            rows = cursor.fetchall()
            if len(rows) == 0:
                cursor.execute(
                    """
                               INSERT INTO public.spots
                               (coord, type, count) VALUES (%s, %s, %s)
                               """,
                    ([coord[0], coord[1], coord[2]], type, 1),
                )

            print("All spots:", rows, flush=True)

    return "success!", 200


@app.get("/coords")
def get_coords():
    with phsyco.connect(os.environ["CONNECTION"]) as conn:
        with conn.cursor() as cursor:
            cursor.execute("SELECT coord, type, count FROM public.spots")
            rows = cursor.fetchall()
            print(rows)
    return {"rows": rows}, 200


@app.post("/signup")
def signup():
    data = request.get_json()
    email = data.get("email")
    password = data.get("password")

    if not isinstance(data, dict):
        return {"error": "Send a json!"}, 400
    elif not isinstance(email, str):
        return {"error": "add an email!"}, 400
    elif not isinstance(password, str):
        return {"error": "add a password!"}, 400

    supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])

    try:
        result = supabase.auth.sign_up({"email": email, "password": password})
    except Exception as e:
        print(str(e), flush=True)
        return {"error": "Signup failed"}, 500

    return {"success": "ok"}, 200


@app.post("/signin")
def signin():
    data = request.get_json()

    if not isinstance(data, dict):
        return {"error": "send a json object!!!"}, 400

    email = data.get("email")
    password = data.get("password")

    if not isinstance(email, str) or not isinstance(password, str):
        return {"error": "send a valid email!"}

    supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])

    try:
        result = supabase.auth.sign_in_with_password(
            {"email": email, "password": password}
        )

        return {
            "user_id": result.user.id,
            "access_token": result.session.access_token,
            "refresh_token": result.session.refresh_token,
            "expires_in": result.session.expires_in,
        }, 200

    except Exception as e:
        return {"error": str(e)}, 401


if __name__ == "__main__":
    app.run()
