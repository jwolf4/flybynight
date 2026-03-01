function pad2(n){ return String(n).padStart(2,"0"); }

function setText(id, text){
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function initAnalogClock(rootId){
  const root = document.getElementById(rootId);
  if (!root) return;

  // build ticks once
  const face = root.querySelector(".analog");
  if (face && face.querySelectorAll(".tick").length === 0){
    for (let i=0;i<60;i++){
      const t = document.createElement("div");
      t.className = "tick" + (i%5===0 ? " major" : "");
      t.style.transform = `translate(-50%,-100%) rotate(${i*6}deg) translateY(-102px)`;
      face.appendChild(t);
    }
  }

  const h = root.querySelector(".hand.hour");
  const m = root.querySelector(".hand.min");
  const s = root.querySelector(".hand.sec");

  function tick(){
    const d = new Date();
    const hours = d.getHours()%12;
    const mins = d.getMinutes();
    const secs = d.getSeconds();
    const ms = d.getMilliseconds();

    const secAngle = (secs + ms/1000) * 6;
    const minAngle = (mins + secs/60) * 6;
    const hourAngle = (hours + mins/60) * 30;

    if (h) h.style.transform = `translate(-50%,-100%) rotate(${hourAngle}deg)`;
    if (m) m.style.transform = `translate(-50%,-100%) rotate(${minAngle}deg)`;
    if (s) s.style.transform = `translate(-50%,-100%) rotate(${secAngle}deg)`;

    setText("localTime", `${d.toLocaleString()}`);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function initCountdown(opts){
  const {
    seconds = 8,
    labelId = "countdownLabel",
    redirectTo = null
  } = opts || {};

  if (!redirectTo) return;

  let remaining = seconds;
  const label = document.getElementById(labelId);

  function render(){
    if (label) label.textContent = `Returning to closed screen in ${remaining}s…`;
  }

  render();
  const timer = setInterval(() => {
    remaining--;
    render();
    if (remaining <= 0){
      clearInterval(timer);
      window.location.href = redirectTo;
    }
  }, 1000);
}