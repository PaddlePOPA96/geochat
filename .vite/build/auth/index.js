"use strict";
const startAuth = document.querySelector("#start-auth");
if (startAuth) {
  startAuth.addEventListener("click", () => {
    startAuth.disabled = true;
    chatguessrApi.startAuth();
  });
}
