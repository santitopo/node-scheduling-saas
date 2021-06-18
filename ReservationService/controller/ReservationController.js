const Pipes = require("../pipeline/pipes");
const axios = require("axios");
const AssignmentCriterias = require("../services/assignmentCriterias");
const MQReservations = require("../communication/mqReservations");
const uniqid = require("uniqid");

module.exports = class ReservationController {
  constructor(countryDataAccess) {
    this.pipes = new Pipes();
    this.assignmentCriterias = new AssignmentCriterias();
    this.mq = new MQReservations();
    this.countryDataAccess = countryDataAccess;
  }

  async fetchPerson(personId) {
    try {
      const response = await axios.get(
        "http://localhost:5006/people/" + personId
      );
      return response.data;
    } catch (error) {
      return null;
    }
  }

  runValidations(body) {
    const validationError = this.pipes.pipeline.run(body);
    if (validationError) {
      const err = {
        status: validationError.code,
        body: validationError.message,
      };
      return err;
    }
  }

  sendReservationToMQ(person, slot, requestBody, reservationCode) {
    try {
      const mq_reservation = {
        dni: person.DocumentId,
        reservationCode,
        assigned: slot ? true : false,
        vaccinationPeriodId: slot ? slot.vaccinationPeriodId : null,
        slotId: slot ? slot.slotId : null,
        date: requestBody.reservationDate,
        turn: slot ? slot.turn : requestBody.turn,
      };
      this.mq.add(mq_reservation);
      console.log("LLEGUE A MANDAR A LA MQ");
    } catch {
      return {
        body: "Error en la conexión con Redis al intentar agregar la reserva",
        status: 500,
      };
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
    console.log("the criterias are ", validCriterias);
  }

  async addReservation(body) {
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
    //Step 3 (Redis) - Aplicar todos los criterios de asignacion para obtener array con ids de criterios aplicables
    const updatedCriterias = this.assignmentCriterias.getUpdatedCriterias();

    const validCriterias = this.getValidCriterias(updatedCriterias, person);
    //Step 4 (SQL) - Update de cupo libre. Deberia devolver el slot
    this.countryDataAccess.updateSlot({
      turn: body.turn,
      reservationDate: body.reservationDate,
      stateCode: body.stateCode,
      zoneCode: body.zoneCode,
      assignmentCriteriasIds: validCriterias,
    });

    const slotAssigned = {
      vaccinationPeriodId: 5,
      slotId: 8,
      turn: 1, //si no se pudo asignar esto viene null
      department: "Montevideo",
      zone: "Centro",
      neighborhood: "Barrio Sur",
    };

    // Step 5
    //Objeto MQ
    // let reservationCode = uniqid();
    // err = this.sendReservationToMQ(person, slotAssigned, body, reservationCode);
    // if (err) {
    //   return err;
    // }
    // // If pudo reservar ->  Dejo la reserva con cupo en la MQ
    // if (slotAssigned) {
    //   return {
    //     body: {
    //       dni: person.id,
    //       reservationCode,
    //       departamento: 0,
    //       zona: 0,
    //       codigo_vacunatorio: 0,
    //       date: body.reservationDate,
    //       turno: 1,
    //       timestampI: new Date(body.timestampI).toISOString(),
    //       timestampR: new Date(Date.now()).toISOString(),
    //       timestampD: Date.now() - new Date(body.timestampI) + " ms",
    //     },
    //     status: 200,
    //   };
    // } else {
    //   return {
    //     body: {
    //       reservationCode: reservationCode,
    //       mensaje: "La solicitud se asignara cuando se asignen nuevo cupos.", //sacar del config
    //       timestampI: body.timestampI,
    //       timestampR: Date.now(),
    //       timestampD: Date.now() - timestampI,
    //     },
    //     status: 200,
    //   };
    // }
  }

  init() {}
};
