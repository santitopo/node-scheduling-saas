const Pipes = require("../pipeline/pipes");
const axios = require("axios");
const AssignmentCriterias = require("../services/assignmentCriterias");
const MQReservations = require("../communication/mqReservations");
const uniqid = require("uniqid");
var moment = require('moment');
const NonAssignedReservationsQueue = require('bull')
const redis = require("redis");
const bluebird = require("bluebird")

module.exports = class ReservationController {
  constructor(countryDataAccess) {
    this.pipes = new Pipes();
    this.assignmentCriterias = new AssignmentCriterias();
    this.mq = new MQReservations();
    this.mqNotAssignedRes = new NonAssignedReservationsQueue("ReservationQueryMQ")
    this.countryDataAccess = countryDataAccess;
    bluebird.promisifyAll(redis);
    this.client = redis.createClient();
  }

  async fetchPerson(personId) {
    let url = await this.client.getAsync("DniCenter")
    try {
      const response = await axios.get(
        `${url}` + personId
      );
      return response.data;
    } catch (error) {
      return null;
    }
  }

  runValidations(body) {
    try {
      const validationError = this.pipes.pipeline.run(body);
      if (validationError) {
        const err = {
          status: validationError.code,
          body: validationError.message,
        };
        return err;
      }
    } catch {
      return "Error reservando el cupo, intente mas tarde."
    }
  }

  async sendReservationToMQ(person, slot, requestBody, reservationCode) {
    try {
      const mq_reservation = {
        phone: requestBody.phone,
        dni: person.DocumentId,
        reservationCode,
        assigned: slot ? true : false,
        vaccinationPeriodId: slot ? slot.vaccinationPeriodId : null,
        date: requestBody.reservationDate,
        turn: slot ? slot.turn : requestBody.turn,
        state_code: slot ? (slot.state_code ? slot.state_code : requestBody.stateCode) : requestBody.stateCode,
        zone_id: slot ? (slot.zone_id ? slot.zone_id : requestBody.zoneCode) : requestBody.zoneCode
      };
      await this.mq.add(mq_reservation, { removeOnComplete: true });
    } catch {
      return "Error en la MQ";
    }
  }

  getValidCriterias(updatedCriterias, person) {
    const resultArray = updatedCriterias.map((f) => {
      if (f.function(person)) {
        return f.index;
      } else {
        return -1;
      }
    });
    return resultArray.filter((e) => e != -1);
  }

  parseDate(reservationDate) {
    const newDate = moment(reservationDate);

    if (newDate.isValid()) {
      const year = newDate.year();
      const month = (newDate.month() + 1).toString().length == 1 ? "0" + (newDate.month() + 1) : (newDate.month() + 1)
      const day = newDate.date().toString().length == 1 ? "0" + newDate.date() : newDate.date();

      const parsedDate = year + "-" + month + "-" + day;
      return parsedDate;
    }

  }

  calculateAge(date) {
    var ageDifMs = Date.now() - date.getTime();
    var ageDate = new Date(ageDifMs); // miliseconds from epoch
    return Math.abs(ageDate.getUTCFullYear() - 1970);
  }

  async addReservation(body) {
    const reservationDate = this.parseDate(body.reservationDate);
    if (!reservationDate) {
      return { body: "Fecha mal provista", status: 400 }
    }
    body.reservationDate = new Date(reservationDate);
    //Step 1 - Validators
    let err;
    err = this.runValidations(body);
    if (err) {
      return {
        status: err.status,
        body: err.body,
      };
    }
    //Step 2 - Request a Registro Civil (Deberian ser apis dinamicamente cargadas)
    const person = await this.fetchPerson(body.id);
    if (!person) {
      return { body: "No se encontró la cédula provista", status: 400 };
    }
    const age = this.calculateAge(new Date(person.DateOfBirth))
    if (age < 16 || age > 106) {
      return { body: "Debes tener una edad entre 16 y 106 años", status: 400 };
    }
    //Step 3 (Redis) - Aplicar todos los criterios de asignacion para obtener array con ids de criterios aplicables
    const updatedCriterias = this.assignmentCriterias.getUpdatedCriterias();

    const validCriterias = this.getValidCriterias(updatedCriterias, person);
    //Step 4 Check for reservations with same id
    const existsReservaion = await this.countryDataAccess.checkDniInReservations(body.id);
    if (existsReservaion.length > 0) {
      return { body: `Ya existe una reserva para la cedula ${body.id}`, status: 400 }
    }
    //Step 5 (SQL) - Update de cupo libre. Deberia devolver el slot
    const slotData = await this.countryDataAccess.updateSlot({
      turn: body.turn,
      reservationDate: reservationDate,
      stateCode: body.stateCode,
      zoneCode: body.zoneCode,
      assignmentCriteriasIds: validCriterias,
    });
    // Step 6
    //Objeto MQ
    let reservationCode = uniqid();
    err = await this.sendReservationToMQ(
      person,
      slotData,
      body,
      reservationCode
    );
    if (err) {
      return {
        body: err,
        status: 500,
      };
    }
    // If pudo reservar ->  Retorno HTTP
    if (slotData) {
      let object = {
        dni: person.DocumentId,
        reservationCode,
        state: body.stateCode,
        zone: body.zoneCode,
        vacCenterCode: slotData.vacCenterCode,
        vaccinationDate: reservationDate,
        turn: slotData.turn,
        timestampI: new Date(body.timestampI).toISOString(),
        timestampR: new Date(Date.now()).toISOString(),
        timestampD: Date.now() - new Date(body.timestampI) + " ms",
      }
      let arr = JSON.parse(await this.client.getAsync("SMSService").then((data) => data).catch((e) => console.log(e)) || "[]")
      for (let i = 0; i < arr.length; i++) {
        await axios.post(arr[i].url, object)
          .then((data) => data)
          .catch((e) => console.log("Error al enviar request a API SMS"))
      };
      //let aux = await axios.post("http://localhost:5007/sms/", object).then((data)=> data).catch((e)=>console.log(e))

      return {
        body: object,
        status: 200,
      };
    } else {
      let object = {
        dni: person.DocumentId,
        reservationCode,
        message: "La solicitud se asignara cuando se asignen nuevo cupos.", //sacar del config
        timestampI: new Date(body.timestampI).toISOString(),
        timestampR: new Date(Date.now()).toISOString(),
        timestampD: Date.now() - new Date(body.timestampI) + " ms",
      }
      let arr = JSON.parse(await this.client.getAsync("SMSService").then((data) => data).catch((e) => console.log(e)) || "[]")
      for (let i = 0; i < arr.length; i++) {
        await axios.post(arr[i].url, object)
          .then((data) => data)
          .catch((e) => console.log("Error al enviar request a API SMS"))
      };
      //axios.post("http://localhost:5007/sms/", object).then().catch((e)=>console.log(e))
      await this.mqNotAssignedRes.add({ state_code: body.stateCode, zone_code: body.zoneCode, assigned: false }, { removeOnComplete: true })
      console.log("added to mq notAssignedRes")
      return {
        body: object,
        status: 200,
      };
    }
  }

  init() { }
};
